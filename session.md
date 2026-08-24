# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Written 2026-08-24. Worktree `/Volumes/Sayulita/Projects/RS/.wt-proofport`,
branch `port/rating-furniture-to-adgen` off `origin/master` @ `9d68b20`.)*

- **What this is.** Fourth port tonight of a backend-only creative fix into
  adgen, where `ADGEN_RENDERER_ENABLED=true` actually renders NEW ads.
  Backend PR #325 (`7cc2c7df`) made `social_proof_led` demand a star-glyph
  widget instead of a rating CLAIM headline. Three delivered ads printed
  "Rated 5 Stars By Everyone Who's Tried Them" (Soludos, two surfaces) and
  "5-star brand-wide rating" (Pelagic PMax) with no stars, numeral, or count.
  Adgen vendored `staticAdIntents.js` / `aiCreativeDirectorService.js` /
  `directImageRenderService.js` and had ZERO `hasUniversalEndorsement` /
  `copyFailsCompliance` hits — the backend fix was inert on the new-ad path.
- **Port, not overwrite.** DIR divergence kept (`usableAttribution`,
  `composeCorrectiveOverride`, `buildQcRetryArgs`,
  `submitEditImageWithSeedFallback`, brand-consistency #14). PMax notes and
  SCENE_PRESERVE kept. `promptFlagsSnapshot` does not exist in adgen — that
  hunk was skipped, not invented.
- **Hunks applied on matching anchors** (staticAdIntents absences / goal /
  furnitureBlock / catch-all carve-out; Director require + validator +
  round-prompt furniture rule + PROOF MENU ternary). **Re-anchored:**
  (1) exports landed after `BRAND_LED_COPY` before the PMax block (backend
  inserted before `SEGMENT_OVERRIDES_ENABLED`, which adgen does not export);
  (2) quote-absence line: backend #325 left `star-glyph row` banned whenever
  there is no quote, which contradicts the widget demand on rating-only
  `social_proof_led` (eligible on rating alone; harness PROOF_DATA always
  has a quote so 130 stayed green). Furniture arm drops that glyph ban;
  flag-off keeps the original sentence. **Skipped:** `promptFlagsSnapshot`
  (adgen never had it; no `verifyQcInsights` / `verifyStaticIntents` here).
- **Require paths.** `adCopyGuards.js` has no `require('../config/…')` —
  it reads `process.env` only. From `src/services/` a `require('./adCopyGuards')`
  is correct. Harness requires rewritten `../services/*` →
  `../src/services/*`. Require-graph 510/510 (was 506/506).
- **Kill switch** `STATIC_RATING_FURNITURE` (default ON) in
  `config/defaults.env`. Flag-off is byte-identical to pre-port prompts on
  all three surfaces AND the Director round system prompt (dumped against
  origin/master before the port was restored).
- **Proof.** `verifyRatingFurniture.js` 130/130 (matches backend; no harness
  edit to chase the count). Extra fixture matrix against REAL functions:
  BLOCK "Rated 5 Stars By Everyone Who's Tried Them", "5-star brand-wide
  rating", "Loved universally by all customers"; KEEP "Rated 4.8 by 2,341
  verified buyers", "Highly rated by the runners who log 50-mile weeks",
  "For the city and everywhere in between." Suite 20/23 → 21/24, same three
  reds (verifyArchiveDigestRelease, verifyModelParity,
  verifyRunFinalizesOnSettle_KNOWN_OPEN).
- **Companion.** `verifyBrandConsistency.js` S-section updated so it does
  not pin the inverted star-row BAN (22 → 24). `resolveCoherentSocialProof`
  / `allowLabeledBrandNumbers` untouched.
- **Pushed.** PR against master. Do not merge.

---

## KNOWN-OPEN

- **`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`** — still labelled expected-fail;
  `maybeFinalizeRun` is wired on this branch. Group A only replays the `$inc`.
- **`verifyArchiveDigestRelease.js` E3/E14** — self-diagnosed broken ported scans.
- **`verifyModelParity.js`** — red in this worktree because sibling
  `liquidretail_backend/models/*` no longer call `mongoose.model(...)` in a
  shape the harness can extract. Also fails while a `node_modules` symlink
  is present (remove it before commit).
- **Orchestrator is not Phase 2.**
- **`titlingResumeService` / `bootRecoveryService` unwired** from adgen boot.
  Isolation leaves resume state; it does not start the sweeper.

---

## Adding an entry

Replace CURRENT STATE / KNOWN-OPEN in place. Do not grow a dated log in
this file.
