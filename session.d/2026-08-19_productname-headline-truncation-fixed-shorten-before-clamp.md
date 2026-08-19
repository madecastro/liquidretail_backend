# 2026-08-19 — productName headline truncation fixed: shorten the source string before the clamp ever fires

Branch `fix/headline-truncation`, off `origin/main` (`3bd30a93`), built in a dedicated
worktree. Follow-up to PR #250 (rating-row half-slice) — same delivered Vuori 2 denim
jacket ad, same run (`run_1787136860887_654ed621`), a DIFFERENT defect in the same
neighborhood: the `productName` (close-phase) slot itself was clamping mid-name.

## The bug

Rendered frames at t=8.0s on current `main`:
- `meta_reels_9_16`: `"Women's Vuori Vintage Oversized…"`
- `meta_stories_9_16`: `"Women's Vuori Vintage Oversized Denim…"`

Same source string, two DIFFERENT cutoffs — the tell that the clamp is width/box-driven
(`deriveCharCap`, `remotion/lib/slotContent.js`), not a fixed character cap on the
source. Traced (via Grok, fanned out across 7 sub-questions) and confirmed directly:
`deriveCharCap('productName', ctx)` returns 32 for Reels (its safe-zone-narrowed width,
837px) vs 38 for Stories (972px, not narrowed — Stories' zone is exactly the vertical
canvas baseline). `truncateWordSafe` was already word-safe (never mid-word) — the actual
defect was upstream: nothing had ever shortened the raw 45-character catalog title
(`"Women's Vuori Vintage Oversized Denim Jacket"`) before either cap fired.

`resolveSlotContentCore` → `deriveCharCap` → `truncateWordSafe` is the resolver;
`slotRenderers.jsx`'s `-webkit-line-clamp` on `TextSlot` is a backstop behind it, not the
cutter (confirmed via the char counts matching exactly, no CSS involvement). PR #250's
`stackFit.js`/`resolveGroupBoxPx` size the group's HEIGHT (top/bottom) — orthogonal, not
touched here.

## The fix — shorten the source, don't just clamp it better

Per owner instruction, priority order: (1) shorten the source string deterministically,
(2) fitting levers, (3) ellipsis only as true last resort, word-boundary, still
identifies the product.

**1) `services/brandScriptExecutor.js` — `cleanProductNameForDisplay(name, brandName)`**
(new second arg, backward compatible — every 1-arg caller unchanged). Added step 4, after
the existing paren/pipe/dash-suffix cleanup:
- Strip a leading gender/audience qualifier — plural/possessive forms ONLY (`Women's`,
  `Womens`, `Kids'`, `Kids`, `Mens`, `Unisex`, …). Bare singular `Men`/`Boy` are
  deliberately excluded — they collide with ordinary English ("Men in Black", "Girl
  Scout"). Guarded: skipped when the brand's OWN name starts with the same word (a brand
  literally named "Women's Health") — never severs a load-bearing token.
- Strip a leading redundant own-brand token — **word-by-word prefix match**, not a single
  substring/exact-string match. This matters concretely: this platform's demo/test
  tenants are literally named `"<Brand> <N>"` (`"Vuori 2"`, `"Pelagic Gear Test 2"` — see
  other `session.d/` entries). An exact-full-string match would silently never fire for
  the very account the incident was reported on. Word-by-word consumes as many of the
  brand's words as the title actually opens with, so `brandName="Vuori 2"` still strips
  `"Vuori "` from a title that (correctly) never repeats the digit.
- Both steps anchored to the START only (never touches a mid-string token) and never
  empty the whole string.
- Wired at the single point every video surface's cascade result already passes through
  (`buildMetaForAd`, ~line 1211) — regardless of which cascade source won
  (`catalogProduct.title` / `layoutInput.input.product.name` / `ad.copy.productName`),
  `cascaded.brandName` (== `brand.name`) is passed through. One insertion point, every
  surface benefits.
- Result for the incident string: `"Women's Vuori Vintage Oversized Denim Jacket"` →
  `"Vintage Oversized Denim Jacket"` (30 chars) — fits Reels' cap (32) AND Stories' cap
  (38) outright. No ellipsis at all for the reported bug.

**2) `remotion/lib/slotContent.js` — new `fitProductNameToCap(str, maxLen)`**, scoped to
the `productName` slot only (wired into `resolveSlotContentCore` via
`slot.key === 'productName'` — every other slot, including `quote`, keeps the plain
`truncateWordSafe`. This matters: PR #250-era fixes depend on the quote's OPENING clause
surviving a tail cut, and a customer quote is not "[modifiers][noun]" shaped — front-
trimming it would produce an inaccurate quote, not a shorter one). Even after step 1,
`squareYt`/`pmax_video_1_1`'s 1-line cap (26 chars) is still shorter than the cleaned
30-char name. `fitProductNameToCap` drops LEADING modifier words one at a time —
`"Oversized Denim Jacket"` (22 chars, fits) — never the trailing noun that actually
identifies the product, and never emits an ellipsis while any whole-word phrase still
fits. This is exactly the fallback the owner's own bug report suggested ("or even
'Oversized Denim Jacket'"). Falls back to `truncateWordSafe`'s tail-cut+ellipsis only
when no whole-word candidate fits at all (e.g. a single pathologically long word).

## Verification — pixels

Re-rendered the exact two shipped ads (`6a858be269d85d0c4123f4e4` stories,
`6a858be569d85d0c4123f521` reels) against the fixed worktree, reusing
`scratchpad/render_main/renderBothMain.js`'s pattern (read-only: `Ad`/`Brand`/
`CatalogProduct`/`LayoutInputArtifact` lookups off the already-populated `ad.basePlate`
cache field, zero Atlas spend, zero upload, zero DB write — `REMOTION_BROWSER_EXECUTABLE`
pointed at the already-downloaded chrome-headless-shell to skip any browser download
too). Frames extracted via `ffmpeg` at t=1.5/4.5/5.5/8.0 for both surfaces:
- t=8.0 (close phase, the reported defect): BOTH surfaces now show
  `"Vintage Oversized Denim Jacket"` complete, two lines, no ellipsis.
- t=1.5/4.5/5.5: byte-identical file sizes to current `main`'s frames at the same
  timestamps for 3 of 4 — confirms zero regression to the hook headline, PR #250's quote
  opening-clause, or the rating row (still complete, `★★★★ 4.6/5`).

## Tests — revert-proof

`scripts/verifyTitleSpecResolution.js`: rewrote G9's two stale "Women's Breezer Point"
pins to the now-correct "Breezer Point" (the gender-strip is the point of the fix); added
**G9b** (12 assertions: the reported string, brand-first ordering, the `"Vuori 2"`
test-tenant shape, case-insensitivity, multi-word brand + "The", a brand that itself
opens with "The", mid-string non-strip guard, never-empty guard, "Men in Black"
false-positive guard, brand-identity guard, no-brandName byte-identical path) and **G10**
(end-to-end: the exact reported raw string through `cleanProductNameForDisplay` +
`deriveCharCap` + `truncateWordSafe`, asserting the RAW string would have clamped on both
surfaces pre-fix and the CLEANED string does not, plus the squareYt fitter).
`scripts/verifyFormatAwareCharCaps.mjs`: new section J (13 checks) — the Reels-vs-Stories
productName cap delta (J1-J3), `fitProductNameToCap` unit behavior (J4-J10), and an
end-to-end `resolveSlotContent` check proving the `quote` slot is byte-unaffected
(J11-J13).

Revert-proven by hand: `git stash` on just the two source files (leaving the new tests in
place) — `verifyTitleSpecResolution.js` failed 3/32 (G9, G9b, G10) with the exact
before/after string diff in the assertion output; `verifyFormatAwareCharCaps.mjs` failed
to even import (`fitProductNameToCap` no longer exported) — `git stash pop` restored
32/32 and 260/260 green.

Full gate: **173/173** `scripts/verify*.{js,mjs}` green (fresh worktree needed
`npm install --no-save https-proxy-agent@5.0.1 jsonwebtoken` first — environmental, not
related to this fix). `npm run lint` clean, zero errors.

## Docs

`docs/TITLING.md` §2 — added a follow-up paragraph immediately after the `stackFit.js`
entry, same incident thread (Vuori 9:16, 2026-08-19).

## Not touched / explicitly out of scope

- `utils/titleNormalize.js` / `displayNormalizeTitle` (the `layoutInputService.js`
  fallback path) — traced and confirmed the live video cascade always routes through
  `cleanProductNameForDisplay` regardless of which cascade source wins, so this path
  never reaches the screen uncleaned for video. Left alone to keep the change minimal.
- `landscapeYt`/`pmax_video_16_9` — canonical has no `productName` slot on landscape (only
  `headline`, which is Director copy, not the catalog title) — not implicated in this
  defect class.
- Static image surfaces — `staticAdIntents.js` explicitly forbids adding a product name
  to the prompt; no productName slot exists there.
- A pre-existing stray `"0"` glyph rendered under the rating row on
  `meta_stories_9_16` at t=4.5 — confirmed byte-identical to current `main`'s frame at the
  same timestamp (not a regression, not caused by this change). Flagged separately, not
  fixed here.
