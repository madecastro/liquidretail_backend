# The prompt levers — what each one does, and what to recommend

Read this before brainstorming a prompt change with someone. The audience is
semi-technical: they ask "what if we used Grok instead of Omni?", "what if we
switched to Gemini direct?", or "what if we changed this bit of the prompt?"
and they need you to know what the bits *are*.

**Rewritten 2026-09-04 — read this box before anything else below.** As of
2026-09-03 (owner-directed, "completely strip the old stuff out
permanently"), the video prompt is **one frozen ~1,159-byte paragraph**
(`corePromptText` in `services/veoPromptBuilder.js`, search "CORE IS THE
PROMPT" for the full story), used for every video model and every
destination. The per-field directive table that used to live in this file
(`cameraStyle`, `transitions`, `objective`, …) **no longer affects the
assembled prompt at all** — `references/prompt-mechanics.md` has the
mechanism. Do not recommend tuning those fields; the section below on
"what still works" replaces that table.

**Ground yourself first, every time:**

```bash
node scripts/rpd/rpd.js prompt                      # video elements + meaning + current text
node scripts/rpd/rpd.js prompt --kind static        # static blocks (unaffected by the video rewrite)
node scripts/rpd/rpd.js models                      # every model, both providers, live floor estimates
```

**Never describe or rewrite a prompt element from memory.** These strings change.
Run the command, quote what it actually says, then propose against that.

---

## What we are actually optimising for

Owner-stated: Meta + PMax ads from a real merchant product photo. Static ads place
the REAL product into **lifestyle and studio** scenes with the product pixel-faithful.
Video brings a **static photograph to life** — camera motion over the real photo,
product never altered. Copy must render faithfully. Judge every suggestion against
that, not against "nicer video".

CORE was adopted specifically because it measurably won on **brand-mark
fidelity** (rendered a printed wordmark correctly on the first try where the
per-SKU directive prompts it replaced garbled it) — so a fidelity complaint
today has a higher bar to clear before "reword the prompt again" is the right
answer. See the ceiling note below.

---

## Video: what still works against CORE (`spec.variants[]`)

| lever | still live? | what it actually does now |
|---|---|---|
| `guidance: "…"` | **Yes — the main lever.** | Prepends a fenced `OPERATOR REFINEMENT` block ahead of CORE. Steers WITHIN CORE's constraints (fidelity / no-added-text); a `CONSTRAINT SUPREMACY` line is appended last so the model can't be talked out of them. This is where "more premium," "less motion," "different mood" experiments belong now. |
| `raw: "…"` | **Yes.** | Full replacement, bypasses CORE and the builder entirely. Use for a from-scratch prompt hypothesis, not a tweak. |
| `patch: [{find, replace}]` | **Yes — the other main lever.** | Surgical find-once-and-replace on CORE's own assembled text. This is now the right tool for "what if this one sentence of CORE said something else" — see the example spec. |
| `directives: {key: "…"}` | **No — provably inert.** | Still patches the legacy `OMNI_DIRECTIVES` / `GROK_DIRECTIVES` / `HOOK_FIRST_DIRECTIVES` / `LIFESTYLE_DIRECTIVES` objects (kept only because one flag-reader, `isHookFirstVideoPromptEnabled`, still gates an unrelated money decision). The harness's own tests assert the OUTPUT is byte-identical to baseline when this lever is used. Do not recommend it as a way to change output; if someone wants to test "what would a per-field prompt look like again," that's a `raw` experiment reconstructing the old shape from git history, not a `directives` patch. |

There is exactly one thing left to tune per-request: `durationSec` (interpolated
into CORE's leading sentence) and the operator-refinement text above. Everything
else about "what does the prompt say" is now a `patch`/`raw` experiment against
CORE's frozen text, which the owner has already measured as a win — treat a
further reword as a real proposal to test, not a drive-by improvement.

### CORE's own text, for orientation (read the live copy with `rpd prompt`, not this list)

The paragraph covers, in order: duration + tone ("premium Meta product
commercial," social-ad camera energy is fine), the hard fidelity lock
(product surface + every printed mark is the sole source of truth, copy it,
don't redraw it), an explicit "spell on-garment text exactly as printed, do
not improvise extra marks" clause, a "product-only catalog still wins on
disagreement" tie-break, and closing bans (no morphing/colour drift/logo
generative-fill, ambience-only audio, no added captions/UI/stickers/text).
It deliberately still says "Meta" on PMax destinations too — kept byte-exact
rather than forked, per the owner's precedent on not re-litigating a measured
prompt for cosmetic reasons.

## Static blocks (`spec.static.variants[].blocks`) — unaffected by the video rewrite

| block | what it controls | recommend? |
|---|---|---|
| `PRODUCT_FIDELITY` | the fidelity core for static | **Measured NULL at n=1/arm** — a tightened rewrite did not beat the canonical block. Prefer testing a different MODEL over rewriting this. |
| `SCENE_PRESERVE` | keep the seed's scene rather than build one | Lifestyle/UGC seeds only — replacing it on a packshot is a hard error (the block is not in that prompt). |
| `SCENE_PRESERVE_EDGE_EXTEND` | edge-extension variant of the above | Same lifestyle/UGC-only caveat. |

Static intents (`spec.static.intent`) select which prompt gets built at all:
`brand_led`, `product_first_lifestyle`, `social_proof_led`, `objection_resolved`.
**An intent silently downgrades when its data is missing** — ask for
`social_proof_led` with no rating and you get `product_first_lifestyle`. The harness
surfaces that as `intentDowngraded`; never let a downgraded arm be reported as the
intent that was requested.

---

## Three traps to state out loud when someone proposes a change

**1. "Edit the directive object" is dead advice.** It was the single biggest
lever in this file before 2026-09-03. See the table above — it is now a
no-op on output. If a colleague, an old PR description, or your own memory
says "tune `cameraStyle`," check the date; that advice predates CORE.

**2. `noText` is gone as a NAMED field, but its RULE is now load-bearing
inside CORE itself — DO NOT REMOVE it.** CORE's closing sentence ("Do not
add captions, UI, stickers, price tags, or any text that is not physically
printed on the product. Ad copy is composited later.") is the same
no-rendered-text invariant the old `noText` directive enforced, now folded
into the frozen paragraph instead of being its own patchable field. Titles
are composited afterwards by Remotion, per surface, with that surface's own
safe zone. If the model renders text, it is burned into the pixels and
cannot be retitled for Reels vs Stories vs feed. Anyone asking for "add the
headline into the video" wants the titling path, not a prompt edit — and
"just delete that sentence from CORE" breaks titling for every surface, not
just the one someone is looking at.

**3. Prompt tuning has a ceiling here — and CORE already cleared a chunk of
it.** An independent July 2026 benchmark found even the leading image models
preserve *complete* product detail in only ~29% of generations, in line with
this repo's own observed ~1-in-3 competitor-mark defect rate. CORE's own
adoption was itself a measured fidelity win over the previous prompts (it
rendered a printed wordmark correctly on the first try where the per-SKU
prompts it replaced garbled it), so a *further* prompt-wording fix now
competes against a text that was already chosen for winning on exactly this
axis. When fidelity is still the complaint after that, the real fix is
measure-and-reject (`adVisionQcService`) or a model swap, not another
reword. Recommend a prompt experiment when the goal is motion, pacing, look,
mood or scene.

**The precedent behind all three, stated once so it doesn't need repeating:**
this is not the first time this repo froze a measured prompt against casual
cleanup. The pre-CORE camera prompt carried a **deliberately** self-contradictory
pair — `transitions` permitted "Smooth crossfades only, ~0.25s" while `doNot`
banned "dissolves" outright, and a crossfade *is* a short dissolve. PR #61
"fixed" that exact inconsistency and was rolled back in full — the owner said
the contradictory version produced better output. That prompt is gone now
(replaced by CORE), but the lesson transferred intact: CORE was chosen by
measurement, not by taste, and "tidying up" a measured, owner-approved prompt
without a new measurement is how the PR #61 regression happened the first
time. Say which you are proposing — a measured experiment, or a cleanup —
before anyone touches CORE's text.

---

## "What if we used a different model or provider?"

Run `node scripts/rpd/rpd.js models` for the live registry (both providers)
and floor estimates, then:

- **The current live path is direct Gemini** (`videoRouter.js`
  `VIDEO_PROVIDER=gemini` → `services/geminiVideoService.js`, model
  `gemini-omni-1.1-flash`, Google's own Developer API — not Atlas). Atlas
  (`google/gemini-omni-flash/image-to-video-developer` and friends) is the
  prior/fallback path and stays fully runnable. **A `spec.models` entry
  matching `/^gemini-/i` routes to direct Gemini automatically** — no
  separate flag, so one spec can put both providers in the same gallery.
- **They now share exactly one prompt** (CORE) — see
  `references/prompt-mechanics.md`. A model/provider comparison is therefore
  a genuinely clean test of the MODEL, not confounded by different prompt
  text, which was not true before 2026-09-03 when Grok ran a shorter,
  hand-authored profile.
- **Direct Gemini has no `seed` parameter.** Atlas's `gemini-omni` paramShape
  does (schema-confirmed) — set `rngSeed` at the spec or variant level to
  pin it and isolate the prompt as the only variable across Atlas cells.
  There is no equivalent for Gemini; repeatability there means holding every
  OTHER input fixed and accepting the model's own stochasticity.
  See `references/operations.md`.
- **Grok i2v takes ONE reference image**, Omni/Gemini take several. Extra
  refs are reframed and then discarded on Grok, so a multi-ref comparison
  including Grok is not apples to apples — say so rather than reporting it
  as a quality difference.
- **Grok's rate is UNVERIFIED** in `MODEL_CAPS`: the estimate exists so the
  budget gate can sum it, but the error direction is unknown (unlike Omni
  developer, which measures ~33% *under* its formula). Keep a first Grok run
  short and read the settled price back.
- **Prompt byte cap differs by model**, but CORE at ~1.16KB is nowhere near
  any of them (Grok/Veo 4096, Omni 20000, Gemini publishes none). This used
  to matter a great deal when the per-field directives could push a model's
  cap; it essentially never will again unless an operator-refinement
  (`guidance`) is unusually long.

---

## How to run a good comparison

- **One variable per arm.** Baseline + one change. Two changes in one arm means you
  learn nothing about either.
- **Dry-run first — it is free** and prints the exact prompt per cell, so the tester
  sees precisely what will be sent before any money moves. It also proves
  Atlas and direct-Gemini cells are getting the byte-identical CORE prompt
  before either one spends anything.
- **Pick a hard product.** A printed logo or busy label IS the test; a plain object
  will pass every arm and teach nothing.
- **n=1 proves very little.** Our block-swap result was a null at n=1/arm and is
  recorded as a null, not a win. Say this before someone concludes from one image.
- **Ask for the budget.** Never invent `--max-usd`; the human sets it.
