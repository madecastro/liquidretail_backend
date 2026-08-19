## 2026-08-19 — Static-creative QC pass: 7 defects on `html_gen`, all in `directImageRenderService.js` / `staticAdIntents.js` — NOT `slotRenderers.jsx`

Branch `fix/static-creative-qc`, resumed from a prior agent's uncommitted worktree
(which had already landed D2/D3/D4/D5-partial/D6/D7/D7b before dying on an API
spend limit) and rebased onto current `main` (`87cfdd00`). This session added the
one missing defect (D1, typeface) and verified the rest.

**Scoping finding, stated up front because the brief that started this
investigation assumed the wrong file:** `renderRoute:'html_gen'` statics
(`Ad.variantKind==='product_image'`, `template` starting `ai_*`) **never touch
`remotion/components/slotRenderers.jsx`**. That file is Remotion/video-only.
The static path is `renderService.renderStage` (`:485-520`) → `directImageRenderService.
renderDirectImage` → `gpt-image-2/edit` (one billable call per surface, model
typesets the copy itself) → local Sharp compositing for the logo only. See
`CLAUDE.md` §00 "STATIC — direct to gpt-image-2/edit… No HTML, no Puppeteer, no
SVG overlay compositing." So every defect below lives in
`services/directImageRenderService.js` (prompt assembly + Sharp logo
compositing) or `services/staticAdIntents.js` (the prompt text builder) — never
in the Remotion titling engine, which a **different, concurrent session** owns
for the video-side `RatingSlot`/`PriceSlot` defects (left untouched, as
directed).

**Evidence batch:** run `run_1787119100250_eef4d871`, Vuori Clothing
(`6a6624b95f5af85a46562ded`), product `6a6624fe5f5af85a46562e38` (Short Sleeve
Heavyweight Tee). Downloaded and pixel-inspected all 18 delivered PNGs plus the
brand's real logo asset (1108x179 RGBA, verified orange→blue gradient) — see the
before/after crops below; none of this required a new billable render.

**D1 — headline typeface, format-dependent (new fix this session).** Root
cause: `staticAdIntents.js`'s LATITUDE clause hands every render "you decide
typeface and weight" with **zero** typography guidance, and each of a run's six
surfaces is an independent `gpt-image-2` submit with no shared state — nothing
keeps six guesses agreeing, and the brief's "styleTheme is null → default font
path" lead was a dead end for THIS path specifically, since static ads never
resolve brand fonts at all (`directImageRenderService.js`, the "Brand fonts are
no longer resolved for static ads at all" note near `conceptLook`). Fixed:
`typefaceDirectiveForBrand(brand)` derives ONE deterministic, BRAND-level (not
concept/surface-level) typeface directive from `Brand.customFonts` /
`websiteFontUsage.heading` — names Vuori's real ingested "aktiv-grotesk",
classifies serif/sans with the same heuristic `fontResolverService.fallbackFor`
uses for video (duplicated by hand, same trade-off as `LOGO_SAFE_MARGIN_PCT` vs
`safeZones.js`, since static must not import the font-FILE-resolving module) —
and asserts it into every surface's prompt identically. No brand font at all
still gets one fixed sans-serif fallback, never a per-call improvisation.
Verified: `scripts/verifyStaticTypefaceDeterminism.js` (40 checks, revert-proven
— removing the wiring fails U7/U8).

**D2 (illegible 9:16 headline), D3 (logo safe-area), D4 (logo desaturation), D6
(`Ad.copy` ≠ rendered copy), D7 (cross-product review quote) — already fixed by
the prior agent, reviewed and left as-is.** All revert-proven
(`verifyStaticTextInk.js`, `verifyStaticGeometry.js` G4c, `verifyLogoColorPreservation.js`,
`verifyCopySnapshot.js`, `verifyQuoteProvenance.js` P8). Re-verified D3/D4
against the REAL Vuori logo + real delivered frame (not synthetic fixtures) —
see the crops in this session's scratchpad; old code forces the gradient to a
flat grey square and overshoots the platform safe margin to x=1015 of 1080,
new code preserves the gradient and clamps to x=999. D7's mechanism is
selection-time noun-filtering (drop the mismatched quote before it ever
reaches the prompt) plus a render-time gate on cached artifacts — stronger than
the pricing ban's "reject the whole round" because it prevents the bad
candidate from being selectable at all rather than generating-then-rejecting.
**Correction to the brief's D7 claim:** the bomber-jacket line is confirmed
contaminating the STORED `Ad.copy.quote` on all 18 (queried live), but the
actual DELIVERED PIXELS on all 6 quote-bearing statics in this run show a
different, generic quote — the code comments call this "a lucky modulus, not a
guard," and it is a second, independent illustration of D6 (the DB field lied
about what rendered) rather than proof the bomber line reached pixels in THIS
run.

**D5 (CTA inconsistent/missing) — casing+colour fixed by the prior agent;
"missing on 4/6" is BY DESIGN, not a defect, confirmed against real pixels.**
`SURFACE_POLICY`/`resolveDrawCta` (`staticAdIntents.js:429-544`): Stories
`drawCta:false` is owner-reaffirmed (2026-08-13, "the platform supplies the
link affordance" — CLAUDE.md flags this explicitly as **do not "fix" it**);
PMax CTA is **intent-resolution-dependent**, true only when the resolved intent
is `objection_resolved` (`PMAX_STATIC_PLATFORM_NOTES=true`, the live default).
Confirmed live: one of this run's `pmax_landscape_1_91_1` renders DOES carry a
CTA (its `ai_social_proof_led` intent apparently fell back to
`objection_resolved` via the eligibility descent CLAUDE.md documents), so
"missing on pmax" is not even a per-surface constant — it varies per resolved
intent. Did not touch `SURFACE_POLICY` or `resolveDrawCta`. The casing/colour
determinism fix (`ctaCasingDirective`, `deriveCtaColors`/`ctaColorDirective`)
is real and needed — confirmed live pixels showing "Shop the tee" (feed_1_1
editorial, dark-green pill) vs "Shop the Tee" (feed_4_5 social-proof, same dark
green) vs a near-black pill on a THIRD feed_1_1 social-proof ad — three
casings/colours for one CTA string in one run, same defect class as D1.

**D7b (pmax_portrait_4_5 scrim clipped at x=0)** — prior agent's fix is a
`staticAdIntents.js` geometryBlock prompt-wording change (names "scrim or
panel" explicitly, requires its own edges inset). Confirmed live: the exact
defect (hard cut at x=0, no left inset) is visible on this run's
`pmax_portrait_4_5` ad. `verifyScrimContainment.js` (55 checks) covers it.

**Verification honesty — what could and could not be confirmed without
spending money:** D3/D4 are LOCAL SHARP COMPOSITING (post-generation) fixes, so
they were re-verified with real production assets (the actual Vuori logo,
the actual delivered stories frame) entirely offline — strong evidence, not
just unit fixtures. D1/D2/D5-casing/D7b are PROMPT-side fixes that change what
the image-GENERATION MODEL itself paints; their effect on real output pixels
can only be confirmed by a new `gpt-image-2` submit (~$0.06-0.07/surface). Per
instructions **no billable run was made**. All five are covered by
revert-proven offline harnesses (the function returns the correct, deterministic
directive text; removing the wiring fails the harness) but that is necessarily
short of a pixel-verified AFTER for the model-painted axes. **Recommend a
small (~6-image, one product) paid re-render before merging if visual proof of
D1/D2/D5-casing/D7b on real pixels is required** — not run this session.

**Suite: 163/163 `verify*.js`/`.mjs` scripts green, `npm run lint` clean.**
(The `session.md` header's "148 on main" / CLAUDE.md's "143/151" are both
stale — the true current count is 163, unrelated to this session's changes.)
`verifyLogoSilhouette.js` did NOT need the usual worktree workaround this time
— this worktree already had a full `npm install` (950M `node_modules`), unlike
the hardcoded-`sharp`-path failure CLAUDE.md warns about.

**Files touched:** `config/defaults.env`, `services/{aiCreativeDirectorService,
directImageRenderService,quoteProvenance,renderService,staticAdIntents}.js`,
`scripts/verify{LogoSilhouette,QuoteProvenance,StaticGeometry,CopySnapshot,
LogoColorPreservation,ScrimContainment,StaticCtaDeterminism,StaticTextInk,
StaticTypefaceDeterminism}.js` (last one new, this session).
