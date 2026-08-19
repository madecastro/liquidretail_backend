## 2026-08-04 (later) — `ai_brand_led` static ads had NO COPY. Fixed, UNCOMMITTED, NOT DEPLOYED

Owner: *"I am getting static generations for the ai_brand_led template without any copy? We have
so much stuff we could put in there how is it we are left with no options?"*

**It was never a data problem.** `ai_brand_led` had no brand-led implementation on the static path.
`TEMPLATE_INTENT` (`directImageRenderService.js:484`) mapped only `ai_social_proof_led` and
`ai_promotional`, so `ai_brand_led` fell to `DEFAULT_INTENT = product_first_lifestyle` — max three
slots (BRAND LINE / TRUST MARK / CTA), and `resolveIntent` short-circuits at chain index 0 because
that intent is unconditionally eligible, so it never escalated even with a strong rating and a
sanitized quote already in hand. `buildIntentData` read only `concept.copy.headline` though
`renderableCopy` also returns `subheadline`/`eyebrow`/`cta`. `layoutInput.copy` (LLM-derived
headline + subheadline, itself falling back to `brand.tagline`) was populated and never read.
With no headline, feed asked for one string ("SHOP NOW") and Stories — `drawCta:false` — hit
`kept.length === 0` and got the **"THIS AD CARRIES NO TEXT AT ALL"** branch.

A `brand_led` creative direction was **already fully specified in two places** and the live path
implemented neither: `aiCanvasSpecService.CREATIVE_STYLES.brand_led` and
`copyDerivationService.STYLE_GUIDANCE.brand_led` (headline 4-6 words, subheadline 4-7, eyebrow 2-4).

**Shipped** (owner decisions: headline+subhead+CTA; cascade to tagline allowed; rating trust mark
only, no quote; brief fix in the same commit):
- `INTENTS.brand_led` (`staticAdIntents.js:533-562`) — `core:['BRAND LINE']`, `rendersSubhead:true`,
  slots BRAND LINE / SUBHEAD / TRUST MARK / CTA. `'SUBHEAD'` added to `SACRIFICE_ORDER` (`:377`).
- Copy cascade in `buildIntentData` (`directImageRenderService.js:548+`): headline
  Director → `layoutInput.copy.headline` → `brand.tagline`; subhead Director →
  `layoutInput.copy.subheadline`; then a **case-insensitive dedupe** (headline wins) because
  `layoutInput.copy.subheadline` itself falls back to `brand.tagline`, so the same string can land
  in both slots and the prompt contract is "each appearing exactly once". Resolved tier is logged
  per render (`headline=director|layout|tagline|none`).
- **Starved Director brief fixed:** `brand_signal.description` ← `brand.summary` (was
  `brand.description`, which is `demographicSchema`'s field, not `brandSchema`'s → permanently
  null); `has_logo` ← `logoUrl`; dead `product.shortBenefits` read dropped. Warning added for a
  null `copy.headline` alone. **`DIRECTOR_SIGNALS_VERSION` 3.0.0 → 3.1.0** — without the bump the
  brief fix is a **no-op** on every product that already has a `CreativeDirectionArtifact`.
- Kill switch **`STATIC_BRAND_LED_COPY`** (default true, `config/defaults.env:105`).

**Byte-identity is MEASURED, not asserted:** 105 prompt comparisons (every pre-existing intent ×
5 surfaces × 7 data conditions) → **zero** differences in BOTH arms. So the change is *additive*
even with the flag on, not merely revertible.

**Verify:** `verifyStaticIntents.js` **1882** (section E added), new `verifyBrandLedCopy.js` **29**
(both arms via require-cache invalidation of BOTH modules — invalidating only one silently tests
the wrong build), `verifyDirectorPrompt.js` **40** (section E). Revert-proven: 5 mutations against
the static/cascade harnesses and 5 against the Director harness, each confirmed to FAIL.
Full suite **53 scripts, 0 failing**.

### Two consequences, deliberately accepted — do not "fix" without asking

1. **`buildIntentData` is shared, so the headline cascade also feeds `product_first_lifestyle`** —
   `ai_ugc_led` and `ai_editorial` now get a brand line where they had none. Strictly additive (no
   new roles: SUBHEAD needs `rendersSubhead`, which only `brand_led` declares) and covered by the
   same kill switch. Not scoped to brand_led because the shared function is where the defect lived.
2. **A `brand_led` ad with no headline from ANY tier degrades via `FALLBACK_ORDER`, and if a rating
   exists it lands on `social_proof_led`, which CAN print a quote** — against the "no quote on
   brand_led" decision. Reachable only when Director copy, layout copy AND `brand.tagline` are all
   absent. Left as documented-known rather than closed: the descent hierarchy is owner-specified
   and a hollow brand-led ad is exactly what `core` exists to prevent.

### Still to do

- **SHIPPED TO A PR, NOT MERGED, NOT DEPLOYED — PR #75** on branch
  `fix/brand-led-static-copy` (base `main`), **two commits**: `7c7acf8` the pre-existing
  product-fidelity hardening (committed first because the brand-led change builds on it in the
  same file — `BRAND_LED_COPY` uses `FIDELITY_HARDENING` as patch context), then `4c5bda8` this
  work. Verified in an isolated worktree at the branch tip: **51/52 green**, the one failure
  (`verifyFontFallback.js`) also failing at plain `main`.
  **The font workstream, `atlasModelMap` / `adRegenerateService`, and the
  `AI_DIRECT_IMAGE_EDIT_MODEL` / `APIFY_ADLIB_*` env vars were deliberately EXCLUDED** and remain
  uncommitted in the working tree — `directImageRenderService.js`, `brandEnrichmentService.js` and
  `config/defaults.env` were staged hunk-by-hunk, asserted clean of font markers. If you pick that
  work up, it still needs its own PR.
- **No live render yet.** First `meta_static` run must be on a brand with BOTH a `summary` and a
  `tagline`, on a product that **already has** a `CreativeDirectionArtifact` (that proves the
  version bump forced a re-derive). 3 billable submits.
- **Watch copy fidelity before anything else.** This adds one string and one absence line to a path
  whose measured baseline is 139/140 strings over 20 renders, where `quality:high` already measured
  *worse* than `medium` by losing a string. If strings degrade → `STATIC_BRAND_LED_COPY=false`
  (no deploy needed) and report the sample.

---

