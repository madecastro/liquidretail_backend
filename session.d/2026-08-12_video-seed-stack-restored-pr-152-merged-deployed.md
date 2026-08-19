## 2026-08-12 — VIDEO SEED STACK RESTORED. PR #152 MERGED + DEPLOYED

**Symptom (owner):** "one seed, not properly resized" — every product video was
rendering from a single reference instead of the agreed main + alt1 + alt2.

**Cause — not the wizard.** The wizard *was* passing 3 seeds. `veoPromptBuilder`
entered its lifestyle branch on `seedStyle === 'lifestyle'`, and `resolveSeedStyle`
buckets **`on_model` as lifestyle**. For an apparel brand (GymShark, Vuori, Marine
Layer) essentially every seed is `on_model`, so nearly every product video took a
path nobody chose — and that path caps references to 1.

**Fix:** entry is now `variantKind === 'ugc'` only. `Ad.variantKind` is a required
enum of exactly `['product_image','ugc']`, so this is precisely the owner's rule:
media path in, product-images path out.

| Ad | Before | After |
|---|---|---|
| UGC (media path) | LIFESTYLE, refs=1 | unchanged |
| product + `on_model` seed | LIFESTYLE, refs=1 | **standard, refs=3** |
| product + packshot seed | standard, refs=3 | unchanged |

Wiring deliberately kept — `VIDEO_LIFESTYLE_PROMPT=true`, prompt and plan untouched —
because lifestyle is unfinished, not abandoned.

Also **reverted `REFRAME_PRODUCT_ONLY_PAD`** back to `true`. The pad only fires for
`isProductOnlyShot`, and on-model seeds never reached it, so flipping it was never
the source of the shaded bars. Reverting also restores the guard against generative
outfill fabricating merchandise.

`verifyLifestylePreserve` 412/412, full suite 108/108, revert-proven (restoring the
seed-style trigger turns V1/V6 red). Merged `5e96f96`, web + worker live 00:08Z.

**Reading the prod log:** the `refs=1` warning is a *catch-all* naming three causes and
cannot discriminate between them. Use `catalogRefInStack` to disambiguate — when it is
`true` with an empty `orderedReferenceMedia`, you are on the auto-assembly path, which
is seed + catalog mirrors *by construction* and can never legitimately yield 1. That
combination means the stack was capped, not that images were missing.

### The shaded bars were in the SEED, not the derive (PR #155, merged `91664e8`)

Second, separate defect, found while verifying #152. The owner's "shaded bars
around the video" were **baked into the pixels** — no downstream crop could ever
have removed them.

The seed is reference input to an image-to-video model, so the model reproduces
whatever it is shown. `reframeReferenceForAspect` was letterboxing seeds to 9:16,
and the model faithfully rendered the bands.

**Why it surfaced only on 08-11:** the pad runs *only* when the generative
outpaint fails, and the outpaint had been dormant since 08-07. Switched back on
it failed **14/14**:

```
outpaint failed — 500 {"code":500,"msg":"failed to upload output 0 to OSS:
  remote media URL must use https"}
```

Zero failures 08-06→08-10, and zero successes either — the path simply was not
running. So every seed hit the pad path at once.

**The rule now:** pad only when the pad is INVISIBLE (solid fill sampled from a
genuinely flat border). Everything else crops. One pure `seedPadDecision` serves
both pad sites; `verifyNoVisibleSeedPad` covers it (10/10, revert-proven).
Product-only shots with a non-flat border crop rather than falling through to the
generative ladder — that branch exists *because* outpaint fabricates merchandise
on product shots, so "not paddable" must not become "pay to invent a garment".

**Still true and NOT fixed: the Atlas outpaint fails 100%, and we are billed for
it.** `billed = true` is set at submit, before the poll. The https-mirror guard
added in #155 is insurance against one class of that error, **not a confirmed
fix** — it could not be reproduced, because the shared default Atlas key
(`CLAUDE.md`) returns **402 insufficient balance** and prod's key lives in Render
env. Until the outpaint works, every video seed takes the crop path. Check the
`outpaint failed` rate before building anything else on reframe.

### Still open — deliberately deferred, in priority order

1. **Lifestyle classification.** `on_model` against a clean background is a packshot,
   not lifestyle. The signal already exists (`technicalInsights.shotStyle`, border
   stdev < 12) but is short-circuited by the LLM label. **`resolveSeedStyle` is shared
   with the STATIC preserve path** — changing it moves statics too. Owner wants an
   operator-facing control so the lifestyle path is *chosen*, never inferred.
2. **Preview over-counts video** by one master on statics-only runs — the frontend
   picker sends a video format alongside the static preset.
3. **Director COPY block** — last source of ALL-CAPS "MEET…" headlines on
   `ai_brand_led`. Awaiting owner go-ahead; it alters Meta copy.
4. **Generic catalog resolver** — the `sitemap-jsonld` path extracts only 1 image
   (Marine Layer: 100/100 products with zero `additionalImages`). This starves the
   3-seed stack at the source for those brands even with #152 in.

**Frontend caution:** the owner's PMax overlay work is uncommitted in
`liquidretail/`. **Never `git add -A` there** — it would revert merged PR #43. Branch
off current `origin/master` and stage only `frontend/app/src/components/adChrome/`.

