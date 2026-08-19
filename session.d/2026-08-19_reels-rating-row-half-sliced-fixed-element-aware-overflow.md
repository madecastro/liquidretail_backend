## 2026-08-19 — Reels rating row was half-sliced; fixed with element-aware overflow

Branch `fix/reels-overflow-element-safety`, off `origin/main` at `c633e2c1`
(after #239/#240/#241/#242 + two later apify/reasoner commits). Worktree
`/private/tmp/.../scratchpad/worktrees/wt-reels-overflow`.

**Follow-up to PR #239** (`2026-08-19_reels-quote-opening-line-silently-dropped-fixed-pr-239.md`).
#239 fixed WHICH end of an overflowing title group's box drops first
(`safe flex-end` — the trailing end, never the opening) and explicitly
flagged its own residual as out of scope: on the patched Reels render, the
proof group's `rating` slot (5-star row + "4.6/5" + review count) was "now
the one that's tight on space and gets partially clipped at its own
trailing edge... purely cosmetic." Re-rendering it and actually looking:
the star row was sliced through its own middle (~30% visible), "4.6/5" cut
mid-glyph, the review-count line gone entirely, ~40% of the frame left as
dead denim below the cut. Not cosmetic — a half-sliced star row reads as a
crashed renderer. Also found (unprompted, by re-rendering more timestamps
than the ticket's own reproduction): the SAME defect class was hitting the
`hook` phase (a 3-line headline sliced mid-word) whenever face/texture
keep-out shifted it into the same tight `lowerThird` box.

**Root cause.** `stackContainerStyle` only ever decided a group's box
(top/bottom px) and let `overflow:hidden` clip wherever the pixel boundary
landed — no notion of whether that boundary fell between two elements or
through the middle of one. `deriveCharCap` (slotContent.js) already sizes a
single SLOT's text to its own box; nothing sized the GROUP (quote +
reviewer + rating, or a lone headline, or productName + CTA row) to the box
its anchor affords after keep-out.

**Fix, two new pieces:**
1. `remotion/lib/safeZones.js` — extracted `resolveGroupBoxPx({ anchor, safe,
   height, offsetY })`, the box-height math `stackContainerStyle` was
   computing inline, into its own exported function (single source of
   truth). While doing this, found the `bottom` anchor had NO `top` at all —
   an intrinsic-height box with nothing above it, so it could never clip but
   also never had the "no spec offset can push content under platform UI"
   ceiling the file's own header claims for every anchor. Gave it the same
   floor `top` gets. Inert for any group that already fit.
2. `remotion/lib/stackFit.js` (new file) — `planGroupFit`, the VERTICAL-axis
   twin of `deriveCharCap`'s horizontal model: estimates a group's real
   stack height from its RESOLVED content (`estimateSlotHeightPx`,
   `estimateTextLines`) and decides, before paint, how to degrade:
   (1) shrink every slot in the group together, bounded to `SHRINK_FLOOR`
   (0.82 — "modest," per the product bar) — preferred over dropping
   anything; (2) drop the `rating` slot's own trailing reviews line only;
   (3) drop whole trailing rows, working backward, protecting the group's
   HERO row. The hero is the first row with REAL content, not literally
   `rows[0]` — `proof`'s `headline` claim-restatement is gated
   `visibleWhenEmpty:"quote"` and can sit at either index depending on which
   one the ad actually uses; hardcoding index 0 would have protected an
   empty placeholder and dropped the real hero. `Canonical.jsx` now
   pre-resolves every slot's content once per group (hoisted out of the
   render loop so the fit planner and the final paint see identical
   numbers), builds one fit-row per folded row (a side-by-side row's height
   is its tallest member's), and applies the plan: scale as an extra
   multiplier on `sizeScale`, `content.reviewsText` stripped when the plan
   says so, whole rows skipped when dropped. `overflow:hidden` stays as a
   last-resort safety net, not the enforcement mechanism — should
   essentially never fire once a group is sized to its box.

**A real, unplanned bug found and fixed while building this**: the first
version of `planGroupFit`'s height total counted one CSS gap per ARRAY row,
including rows with zero content (the `visibleWhenEmpty` placeholder,
`reviewer` when the ad has none). On the actual Vuori ad — no reviewer name
— that wasted 2 phantom row-gaps (84px) out of Reels' 211px budget, which
was enough to tip the plan into dropping the WHOLE rating row instead of
just its reviews line. Fixed `totalAt` to only count gaps between rows that
actually render (`heightPx > 0`), matching what `Canonical.jsx`'s own row
map does (a null row returns `null`, no DOM node, no CSS gap around it).
After the fix: Reels shows the complete quote AND a complete, unsliced
5-star row + "4.6/5" (just the review-count line dropped) — strictly better
than "no rating row at all," which was the outcome before this second fix
and would still have satisfied the bar but wastes real content
unnecessarily.

**Cross-surface check (not special-cased to Reels).** Asked Grok
(`~/.grok/bin/grok -m grok-4.6 --effort high`) to survey `verticalYt`,
`landscapeYt`, `squareYt` and the `pmax_video_*` aliases for the same
tight-box exposure, independently of my own reading. Findings: `verticalYt`/
`pmax_video_9_16` share Reels' exact 211px `lowerThird` box (same zone
numbers) — exposed. `landscapeYt`/`pmax_video_16_9` is WORSE — only 108px
(`bottom:0.36` on a 1080-tall canvas, not 1920), and this is the SAME
surface `scripts/verifyStackSafeFloor.mjs` already documents a real,
previously-measured overflow on (Marine Layer, run
`run_1786526271150_7d498862`, rating/review text 100px inside YouTube's
chrome band) — that 2026-08-12 fix added `overflow:hidden` to stop painting
under chrome, which converted the defect into exactly this clip-through-an-
element class, just not diagnosed as such at the time. `squareYt`/
`pmax_video_1_1` has ~389px, not exposed. No special-casing was added
anywhere — `planGroupFit`/`estimateSlotHeightPx` take no format/
platformFormat, so the fix already covers `verticalYt`/`landscapeYt`
"for free" through the same `Canonical.jsx` code path every surface shares.
Verified via the offline pure-function harness (section F,
`verifyReelsOverflowSafety.mjs`) with each surface's real box height and a
deliberately oversized synthetic group — not via a second paid render,
matching PR #239's own stated convention for the surfaces it didn't
exhaustively re-render either.

**Proven on real pixels.** Re-ran the exact harness PR #239 built
(`scratchpad/wtruncation/render/renderBoth.js`, `renderTitles()` called
directly against the same already-paid Vuori `veoVideoUrl` for both
`meta_reels_9_16` and `meta_stories_9_16` — no Atlas submit, no upload, no
DB write), pointed at this worktree via `NODE_PATH=<main checkout>/node_modules`
(this worktree's own `node_modules` doesn't carry `@remotion/*` — git-tracked
subset only). Frames pulled with ffmpeg at t=1.5/4.5/5.5/8.0s, before and
after:
- Reels t=1.5 (hook): before — headline "The softest denim jacket you'll…"
  sliced mid-glyph on its second line. After — headline dropped whole (even
  shrunk it doesn't fit 211px alongside the badge); "TOP RATED" + productName
  render complete, nothing partial.
- Reels t=4.5/5.5 (proof): before — quote complete (already fixed by #239),
  star row sliced ~30% through, "4.6/5" cut mid-glyph, review count gone,
  ~40% dead space below. After — quote complete, COMPLETE 5-star row +
  "4.6/5" (no partial star, no partial glyph), review-count line absent
  (the one thing that didn't fit), comfortable margin below.
- Reels t=8.0 (close): unaffected before and after (already fit).
- Stories, all four timestamps: **byte-identical whole-file MD5** before vs.
  after (`b6cc2f43fcd434a1a7204ee7f943dd56` both times) — proves the fix is
  fully inert for a surface that already had room to spare.

**Tests.**
- `scripts/verifyReelsOverflowSafety.mjs` (new, 172 checks): unit coverage
  for `estimateTextLines`/`estimateSlotHeightPx`; `resolveGroupBoxPx`
  bounded for every anchor × zone combination; `planGroupFit`'s full
  priority order including the hero-by-content and phantom-row-gap cases;
  the exact shipped-incident numbers re-derived and asserted end-to-end
  (section E); the cross-surface exercise (section F); the `bottom`-anchor
  ceiling (section G). **Revert-proven by hand, not asserted**: reverted
  each of the three code changes in isolation (bottom-anchor ceiling,
  hero-by-content, phantom-gap fix) and confirmed the exact named checks
  went red (C1/C3/G1-G3; D5; D8/D8b/**E2**), then fully neutering
  `planGroupFit` to a no-op and confirming 11 checks fail including the
  master invariant (E4: "simulated=275.9 box=211.2" — the actual overflow
  amount) — then restored and confirmed clean (`diff` against pre-revert
  backups showed zero difference).
- `docs/TITLING.md` — extended the existing 2026-08-19 paragraph (added by
  #239) with the follow-up.
- Full offline suite: **169/169 verify*.js/.mjs scripts pass** (a fresh
  `npm install --no-save https-proxy-agent@5.0.1` was needed first — the 3
  `sharp` scripts' known worktree gotcha, environmental, not a code issue;
  confirmed identical script count/behavior to PR #239's own baseline).
  `npm run lint` — clean, repo-wide.
- `git diff --numstat origin/main` before opening the PR — only the intended
  files (`remotion/lib/safeZones.js`, new `remotion/lib/stackFit.js`,
  `remotion/compositions/Canonical.jsx`, new
  `scripts/verifyReelsOverflowSafety.mjs`, `docs/TITLING.md`, this file).

**What I did NOT do:** re-render a real `pmax_video_16_9`/`squareYt`/
`pmax_video_9_16` ad end-to-end (no ad I own on those surfaces was at hand,
and PR #239 itself only exhaustively covers `vertical`'s two Meta surfaces
by real render, covering the rest offline) — covered by the pure-function
harness instead, same convention. Did not touch the `'top'`/`'upperThird'`/
`'center'` anchors' CSS beyond routing them through the same
`resolveGroupBoxPx` helper (their `overflow:hidden`/no-justify-override
behavior is unchanged; `verifyStackSafeFloor.mjs` still asserts this).
