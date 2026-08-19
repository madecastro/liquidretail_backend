## 2026-08-19 — Reels burned-in quote lost its opening line; fixed, PR #239

Branch `fix/reels-quote-truncation`, PR #239 (backend, MERGEABLE vs main).
Worktree `/private/tmp/.../scratchpad/worktrees/wt-reels-truncation`, off
`origin/main` at `5281a9f1`, rebased cleanly onto `dcca06cb` (#238 merged
mid-session — 4 commits, no conflicts).

Reported: a delivered Vuori `meta_reels_9_16` (run
`run_1787136860887_654ed621`, product Women's Vuori Vintage Oversized Denim
Jacket) burned in the quote `"cinched at the waist but not tight"` as just
**`"not tight"`** — opening clause gone — while the byte-different
`meta_stories_9_16` sibling kept it whole, same base plate, same t=5.5s
instant. `CLAUDE.md` §00 step 4 (the `reels` safe-zone entry, landed the day
before via PR #219) had already predicted a related-but-incomplete cause: the
right-inset widening (0.075→0.15 for the IG action rail) narrows the wrap
measure but `deriveCharCap` never subtracted safe insets from its width
model, so its cap ran optimistic for Reels. That's real, but it doesn't
explain THIS incident on its own — the shipped 35-char quote never crosses
even the tightened cap either way (see below).

**The actual mechanism, found by tracing `stackContainerStyle` +
`resolveGroupAnchor`, then confirmed on real re-rendered pixels (not just
read from source):** the quote's group is authored `upperThird` but a
face/texture keep-out shift (deterministic from the shared base plate, so
identical for both surfaces) moves it to `lowerThird`, which anchors via
`justifyContent:'flex-end'` — hug the safe-zone floor. Reels kept its
`bottom:0.35` (tight, unchanged since always) while Stories moved to
`bottom:0.14` (loose) in the SAME PR #219 that added Reels' right rail, so a
`lowerThird` group's real HEIGHT budget shrank hard on Reels only (~211px)
vs Stories (~614px). When the stack (quote + rating) doesn't fit that
budget, `flex-end` pushes everything toward the floor and the excess spills
PAST THE TOP — clipped by the pre-existing `overflow:'hidden'`. The quote is
the first (topmost) item in the stack, so its opening line is what
vanishes. Verified the exact mechanism in isolation with a minimal HTML
repro in the Claude Browser tool before touching source: bare `flex-end`
reproduces "opening line clipped, tail visible" byte-for-byte; CSS
`safe flex-end` (Box Alignment L3) falls back to start-alignment on
overflow and reliably drops from the trailing end instead.

**Fix, two parts, both required (neither alone closes the incident):**
1. `remotion/lib/safeZones.js` `stackContainerStyle` — `bottom`/`lowerThird`
   now use `justifyContent:'safe flex-end'` instead of bare `'flex-end'`.
   This is the fix that actually stops the opening from being dropped.
2. `remotion/lib/slotContent.js` `resolveUsableWidthPx` — new
   `resolveSurfaceSafeWidthPx()` bounds the char-cap width estimate by the
   surface's own resolved safe-zone width whenever it's narrower than the
   canvas format's shared default (gated on `ctx.safeZoneKey`/
   `ctx.platformFormat`, a field only `Canonical.jsx` populates — every
   pre-existing caller that only passes `format` is byte-identical).
   Tightens `reels`/`verticalYt`/`landscapeYt`/`squareYt`/`pmax_video_*`;
   inert for `vertical`/`stories`/`feed`/`square`/`landscape`. This is the
   documented-but-latent width gap from #219's own comment — real for
   longer copy, just not what broke THIS quote (35 chars never crosses even
   the tightened cap; `scripts/verifyReelsSafeZone.mjs` H10 pins that
   explicitly so nobody re-derives cause 2 as sufficient on its own).

Proven on real pixels for free: called `renderTitles()` directly (the same
function `services/brandScriptExecutor.js` `renderWithRemotionAndSave` calls)
against both ads' already-paid `veoVideoUrl`, stopping before
`uploadRenderAndStamp` — local temp file only, no Cloudinary upload, no
`Ad.updateOne`, no Atlas submit. Before: Reels shows `"not tight"` only;
Stories shows the full 2-line quote. After: both show the full quote (Reels
now 2 lines, "cinched at the waist but" / "not tight""); whole-file
checksums between the two surfaces still differ (the #219 divergence is
preserved, not regressed). One residual, explicitly out-of-scope-for-this-fix
observation: on the patched Reels render the trailing rating/review-count
row (not the quote) is now the one that's tight on space and gets partially
clipped at ITS trailing edge — the safe direction, and purely cosmetic
(readable stars + "4.6/5" mostly intact) versus the meaning-changing bug it
replaced. Not chased further — would need a real per-group height budget,
out of scope here.

Extended `scripts/verifyReelsSafeZone.mjs` (sections G/H, +20 checks, now
51/51) rather than duplicating it, per its own "extend, don't duplicate"
convention. Both fixes revert-proven by temporarily undoing each in turn and
confirming the new checks go red by name (G1-G3 for the alignment revert,
H5-H6 for the width-bound revert), then restoring and re-confirming green.
`scripts/verifyFormatAwareCharCaps.mjs` stayed 247/247 unchanged — its
real-delivered-artifact pins for `vertical`/`landscape` (the "~46"/"~32"
budgets measured off a Marine Layer clip) are untouched, by design.

Also updated `docs/TITLING.md`'s vertical-safe-zone section, which still
described Reels/Stories as sharing one zone (pre-#219 stale) and framed
`lowerThird`/`bottom` overflow as merely "can overflow into the cleared
band" rather than naming which end drops. `CLAUDE.md` §00 step 4 gets a new
paragraph closing the loop on its own PR #219 prediction.

Full offline suite from the worktree: 166/169 green — confirmed via TWO
independent full runs plus per-file isolation, because the first full run
was contaminated by my own concurrent `git stash` experiments (accidentally
stashing a `node_modules`-as-symlink swap, which conflicted `session.md` and
briefly broke an unrelated script that walks `node_modules` looking for
vendor code — `verifyArchiveDigestRelease.js` E14a). Cleaned up (restored
`session.md` to HEAD, restored the real `node_modules`, re-ran clean) and
got a stable 166/169 twice. The 3 failures are the already-known
`sharp`-in-a-worktree trio (`verifyLogoSilhouette.js`,
`verifyLogoColorPreservation.js`, `verifyStaticTextInk.js`) — confirmed
identical on a `git stash` of my own changes, so not a regression. One
`.mjs` script (`verifyTitleBeatScale.mjs`) needs the real `remotion` npm
package, which `NODE_PATH` cannot rescue for ESM resolution (CommonJS-only,
per the existing gotcha note) — ran it once via a temporary, immediately-
reverted `node_modules → main-checkout` symlink swap done in isolation (no
concurrent git commands this time); 42/42. `npm run lint`: clean, repo-wide.

**Lesson for the next worktree session doing anything with `git stash` here:**
don't. `node_modules` is git-tracked in this repo, and if you've temporarily
swapped it for a symlink (to borrow a complete `node_modules` from another
checkout for one ESM script), `git stash`/`stash pop` will try to diff/merge
that as thousands of tracked-file changes and can produce a spurious
`session.md` conflict with a COMPLETELY UNRELATED pre-existing stash entry
sitting in the same (repo-wide, not worktree-scoped) stash list. Do the
symlink swap, run the one script, swap back immediately, with zero `git`
commands in between.
