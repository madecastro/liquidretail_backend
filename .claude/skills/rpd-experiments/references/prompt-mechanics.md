# How the prompt is actually assembled

`references/prompt-elements.md` says what each lever *means*. This says where every
line of the final prompt *comes from*, so you can answer "why did it say that?" and
"what would actually change if we edited X?" without guessing.

All anchors verified against source 2026-08-18. Selectors change — re-read the
first `return` of a resolver before trusting a claim about it.

---

## Video — `services/veoPromptBuilder.js` `buildVeoPrompt()`

### Step 1: which directive SET is used

Two independent decisions, and they compose:

```
promptProfileFor(caps, {platformFormat, promptProfile})
  1. explicit opts.promptProfile            → that profile (harness override)
  2. platformFormat starts "pmax_video_"
     AND PMAX_VIDEO_DIRECTIVES !== 'false'  → 'pmax'
  3. caps.paramShape starts "gemini-omni"   → 'gemini-omni'
  4. otherwise (grok, veo, missing caps)    → 'grok'

shouldUseLifestyleVideoPrompt(seedStyle, variantKind)
  VIDEO_LIFESTYLE_PROMPT === 'true'  AND  variantKind === 'ugc'  → LIFESTYLE_DIRECTIVES
```

Lifestyle **replaces** the packshot set for scene/motion; a PMax destination then
composes *on top* (hook-first line, centre-safe camera line, Frame lines). So a
lifestyle PMax ad draws from both.

⚠️ **`caps.family` is NOT read.** A fixture passing `{family:'gemini-omni'}` silently
gets **Grok** directives. Use `paramShape`.

### Step 2: assembly order (the actual `lines.push` sequence)

1. `OPERATOR REFINEMENT (HIGHEST PRIORITY…)` — only when operator text exists
2. `role`, `objective`
3. lifestyle+PMax only: extra hook-first line
4. `sourceImages`, `productPreservation`
5. `Product: ${product.title}.` — only if a title was supplied
6. lifestyle only: product-anchor / subject-hold block (flag-gated)
7. **`Timeline (${dur}s):`** — 3 scenes, beats at `dur/3` and `dur*0.64`
8. `transitions`
9. `cameraStyle` (split-stage may substitute a centre-safe sentence)
10. PMax only: `Frame (16:9…)` / `Frame (9:16…)`
11. `background`, `visualStyle`, `audio`, `noText`
12. `seedHasText` only: the burned-in-text lock paragraph
13. `physicalAccuracy`
14. lifestyle only: `ambientLife`
15. **`PRODUCT FIDELITY:`** — multi-view wording vs seed-only wording
16. `doNot`
17. `Output: ${dur}s duration.…`

Then `enforceByteCap` joins with spaces.

**The Timeline and Output lines are GENERATED, not directives.** You cannot edit
them via `directives` — they come from `durationSec`. That is why duration is a
prompt change as much as a cost change.

### Step 3: where the operator text comes from (first hit wins)

```
1. generateForAd({operatorPrompt})   → prepended inside buildVeoPrompt
2. ad.videoPromptRaw (trim non-empty) → FULL REPLACE, bypasses the builder entirely
                                        (logs "canonical directives bypassed")
3. guidance cascade, first non-empty, NO concatenation:
     ad.videoPromptGuidance  →  product.videoSettings.promptGuidance
     →  category chain leaf→root  →  brand.videoSettings.promptGuidance  →  null
   (lifestyle only: falls back to a per-intent snippet if the cascade is empty)
```

The harness maps these to levers: `guidance` = tier 3, `raw` = tier 2.

### Step 4: the byte cap, and what gets sacrificed

Cap is `caps.promptByteCap` (Omni 20000, Grok/Veo 4096) minus a 96-byte margin.
Over cap, lines are dropped **in this order**:

```
Product:  →  PHYSICAL ACCURACY:  →  Transitions:  →  Visual style:
```

Load-bearing lines (role, timeline, noText, product fidelity, doNot) are never
dropped. **This matters for model swaps:** the same directives that fit Omni's
20000 can push Grok's 4096 over, silently costing you `Transitions` — the very
lever you may be testing. The harness refuses over-cap prompts rather than
shipping a truncated arm.

### Step 5: the inputs that change wording without any prompt edit

| input | effect on the prompt |
|---|---|
| `durationSec` | Timeline beats and the Output line. Snapped to the model enum (`resolveDurationSec`) BEFORE the prompt is built, so the text reflects what will actually be sent. |
| `hasProductReference` | multi-view vs seed-only PRODUCT FIDELITY paragraph. Live rule: ≥2 images AND a catalog ref in the stack. |
| `seedHasText` | adds the locked-burned-in-text paragraph. Live rule: `media.text` non-empty. |
| `aspectRatio` | PMax Frame line; 9:16 vs 16:9 timeline wording. Meta's timeline ignores aspect. |
| `platformFormat` | picks the PMax profile. |
| `variantKind: 'ugc'` | picks the lifestyle set (with the flag on). |

### The reference stack (what the model actually sees)

`buildReferenceImages`: position 0 = the seed, then catalog media in **feedIndex**
order, capped by `referenceCount` (default 3, hard ceiling 5 on the default branch).
Each is cropped to the render aspect (Cloudinary `c_fill,g_auto`, 720 short edge) or
generatively reframed if that path is enabled. Grok i2v takes **one** image, so extra
refs are prepared and then discarded — never report that as a quality difference.

---

## Static — `services/staticAdIntents.js` `buildPrompt()`

### Step 1: which intent actually renders

`resolveIntent` can **downgrade**. Each intent declares eligibility:
`social_proof_led` needs a rating, `objection_resolved` needs a quote, `brand_led`
needs a headline; `product_first_lifestyle` is always eligible and is the floor.
`brand_led` is NOT in `FALLBACK_ORDER`, so it is only reachable when requested.

The harness records `intentDowngraded` and badges it. An arm labelled with the
requested intent that rendered a different one is a broken comparison.

### Step 2: which fidelity arm

```
FIDELITY_HARDENING = STATIC_PROMPT_FIDELITY_HARDENING !== 'false'   → PRODUCT_FIDELITY
                                                          else      → LEGACY_PRODUCT_FIDELITY (one line)
```

So with the flag off, `blocks: {PRODUCT_FIDELITY: …}` **errors** — the block is not
in the prompt. That is deliberate: it means the arm you named is not the arm that
would render.

### Step 3: scene-preserve vs scene-build

`shouldPreserveScene({seedStyle, variantKind})` needs
`STATIC_LIFESTYLE_PRESERVE === 'true'` **and** a lifestyle-or-UGC subject. The
surface treatment can still veto it (16:9 / PMax landscape → not supported). A
packshot never preserves, so `SCENE_PRESERVE` is absent from its prompt.

### Step 4: geometry is computed, not written

`computeSurface(key)` derives the **generate size** (`surface.generate`, e.g.
`1024x1024`) and the text-safe box; `geometryBlock` renders that into the
model-facing paragraph. Edge margin is 6% for Meta, **10% per-axis** for live PMax
statics. You change geometry by changing the **surface**, never by editing prose.

### Step 5: copy, and what production feeds it

In production `directImageRenderService.buildIntentData` assembles `data`:
headline via Director → `layoutInput.copy` → `brand.tagline`; quote via the
provenance-gated quote pipeline; proof numbers via `resolveCoherentSocialProof`;
CTA via `layoutInput.cta.text || 'SHOP NOW'`; badge always undefined.

**The harness supplies `data` from the spec instead**, so no DB is needed — and it
passes proof-class fields **only when the operator supplies them**, because a
defaulted rating or quote is a fabricated claim.

### Step 6: what gets sacrificed when the copy set is too dense

`SACRIFICE_ORDER`, dropped first → last:

```
BADGE → ATTRIBUTION → SUBHEAD → TRUST MARK → CUSTOMER QUOTE → RATING → BRAND LINE
```

`absences` then states what is *missing* explicitly — an intent that never shows a
quote says so, or the model borrows one from context.

---

## Using this in a brainstorm

- Someone says "make the video feel more premium" → that is `visualStyle` /
  `cameraStyle`, not `productPreservation`.
- "The product looks wrong" → fidelity: prefer a model swap or QC over prose
  (see the ceiling note in `prompt-elements.md`).
- "Put the headline in the video" → titling, not the camera prompt (`noText` stays).
- "Make it shorter/punchier" → `durationSec` changes the Timeline text *and* the
  price; that is one edit with two effects, so say both.
- "Try Grok" → check the byte cap and the single-reference limit before comparing.
