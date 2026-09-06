# How the prompt is actually assembled

`references/prompt-elements.md` says what each lever *means*. This says where every
line of the final prompt *comes from*, so you can answer "why did it say that?" and
"what would actually change if we edited X?" without guessing.

**Rewritten 2026-09-04 for the CORE architecture (owner-directed 2026-09-03) —
the previous version of this file described a per-field directive system that
no longer drives output. If you find a stale copy of this file, or anyone's
memory of "the Timeline/Scene/Output prompt," distrust it and re-read
`services/veoPromptBuilder.js`'s `buildVeoPrompt` directly — the header
comment above `corePromptText()` (search "CORE IS THE PROMPT") tells the
whole story with dates and owner quotes.**

All anchors verified against source 2026-09-04. Selectors change — re-read the
first `return` (or, here, the first `lines.push`) before trusting a claim about it.

---

## Video — `services/veoPromptBuilder.js` `buildVeoPrompt()`

### The one fact that matters more than any of the mechanism below

`buildVeoPrompt` pushes exactly ONE prose block for every call, regardless of
model, destination, or provider: `corePromptText(durationSec)` — a frozen,
~1,159-byte paragraph (sha256 `67899bcfdf16…`, pinned by
`scripts/verifyCorePrompt.js`). It replaced 14,883 bytes of per-field
directive objects (`OMNI_DIRECTIVES`, `GROK_DIRECTIVES`,
`HOOK_FIRST_DIRECTIVES`, `LIFESTYLE_DIRECTIVES`) after nine hours of measured
comparison found this single prompt beat every per-SKU / fidelity-block
variant on the thing that actually matters: brand marks surviving intact.
Owner, verbatim, at the changeover: *"no do it all now, this is what we spent
9 hours on!"* and *"completely strip the old stuff out permanently."*

This is **the same prompt for Atlas and for direct Gemini** — `buildVeoPrompt`
doesn't know or care which provider will submit its output.
`services/atlasVideoService.js` and `services/geminiVideoService.js` both call
it, and the RPD harness's own D1-equivalent check
(`scripts/verifyRpdHarness.js`) proves a Gemini cell and an Atlas cell at the
same duration are byte-identical.

### What is still real, and what is vestigial

The old profile-selection machinery (`promptProfileFor`,
`directivesForProfile`, `shouldUseLifestyleVideoPrompt`, the whole
`OMNI_DIRECTIVES`/`GROK_DIRECTIVES`/`HOOK_FIRST_DIRECTIVES`/
`LIFESTYLE_DIRECTIVES` object family) is **still exported and still computed**
inside `buildVeoPrompt` — but its output (`d` / `dBase` in the source) is
never pushed into `lines` any more. It is kept only because
`isHookFirstVideoPromptEnabled()` is still read by an unrelated MONEY gate
(`campaignAdsGenerationService.isSharedPortraitPlatePromptCoherent`, the
$1.80-vs-$2.70 mixed Meta+PMax master-sharing decision) — deleting the shim
would silently pin that gate closed. **Patching `directives.<key>` in an RPD
spec still runs (D5-equivalent: the singleton is restored byte-identically)
but is now PROVABLY INERT on the assembled prompt** — the harness's own
`verifyRpdHarness.js` D4/E7 checks assert the patched output equals baseline,
not that the patch appears in it. Do not tell someone "edit `objective` to
change the pacing" — it will not.

What DOES still change the assembled prompt, in this order:

1. `OPERATOR REFINEMENT (subordinate to the constraints below).` — a fenced
   block, only when `operatorPrompt` is non-empty. The fence delimiters
   (`<<<OPERATOR>>>` / `<<<END_OPERATOR>>>`) are neutralized if the operator's
   own text contains them, so a pasted delimiter cannot escape the fence.
2. `corePromptText(durationSec)` — always. Only the leading `"{N}-second …"`
   duration is interpolated; the rest is byte-frozen.
3. `CONSTRAINT SUPREMACY: …` — only when operator text exists, and it is
   deliberately the LAST element pushed (recency is what makes a model treat
   it as the tie-breaker over the operator's own words).

That's the whole `lines` array. `enforceByteCap` joins it and — only on the
operator-path, and only if the assembled text is over the model's
`caps.promptByteCap` — degrades the operator explanation before failing
closed. CORE itself is never a drop candidate; at ~1.16KB it has never been
observed anywhere near any real model's cap.

### Where the operator text comes from (first hit wins) — unchanged by CORE

```
1. an explicit `prompt` argument   → dry-run / harness callers only
2. a non-empty `operatorPrompt`    → ALWAYS wins (regenerate / guidance cascade)
3. `ad.veoPrompt`, ONLY when genuinely resuming an existing receipt
4. CORE, with the operator's text folded in per the fence above
```

The harness maps these to levers: `guidance` = tier 2 here (still called
"OPERATOR REFINEMENT" in the prompt itself), `raw` = full bypass of the
builder entirely (`enforceRawByteCap`, never reaches CORE or the fence).

### The inputs that still change wording

| input | effect on the prompt |
|---|---|
| `durationSec` | The one interpolated number, at the very start of CORE (`"{N}-second premium Meta product commercial…"`). Snapped to the model's enum (Atlas) or clamped to Gemini's documented 3-10s range BEFORE the prompt is built, so the text reflects what will actually be sent. |
| `operatorPrompt` (guidance / regenerate) | The fenced block + the supremacy line, both new-since-CORE features kept deliberately (see the header comment). |
| everything else (`platformFormat`, `seedStyle`, `variantKind`, `subjectSide`, `hasProductReference`, `seedHasText`, `promptProfile`, `caps`) | **Computed, and then discarded.** These still steer the vestigial directive-selection machinery, which no longer reaches the prompt. Two fixtures that differ ONLY in these fields, at the same duration and operator text, produce a byte-identical prompt. |

### The reference stack (what the model actually sees) — provider-specific

- **Atlas**: `buildReferenceImages` — position 0 = the seed, then catalog
  media in feedIndex order, capped by `referenceCount` (default 3, hard
  ceiling 5 on the default branch). Sent as plain URL strings.
- **Direct Gemini**: `assembleReferences` (own module,
  `services/geminiReferenceAssembly.js`) builds the equivalent stack, but the
  Developer API takes **inline base64 image bytes**, not URLs — the harness
  fetches and encodes each reference at submit time only (never during a dry
  run), so a dry run never touches the network on this provider either.

---

## Static — `services/staticAdIntents.js` `buildPrompt()`

Unaffected by the video CORE rewrite — a completely separate builder for a
completely separate (image) generation path.

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

- Someone says "make the video feel more premium" or "less camera motion" →
  that is no longer a directive edit. It is either a `guidance` operator
  refinement (steers WITHIN CORE's constraints) or a `patch`/`raw` experiment
  against CORE's own text — say which, and say that CORE itself is
  owner-frozen pending a measured proposal, same precedent as the old
  crossfade contradiction.
- "The product looks wrong" → fidelity: prefer a model swap (Atlas vs direct
  Gemini) or QC over prose (see the ceiling note in `prompt-elements.md`).
  CORE was specifically the measured WINNER on this axis already — a further
  prose tweak is a harder sell than it used to be.
- "Put the headline in the video" → titling, not the camera prompt (CORE's
  own no-added-text line stays).
- "Make it shorter/punchier" → `durationSec` changes the interpolated leading
  number *and* the price; that is one edit with two effects on Atlas, and on
  Gemini it is bounded to 3-10s.
- "Try Grok" (Atlas) or "try direct Gemini" → check the byte cap / reference
  count on Atlas models; direct Gemini has no seed parameter and a different
  (token-based) price model — see `references/operations.md`.
