# The prompt levers — what each one does, and what to recommend

Read this before brainstorming a prompt change with someone. The audience is
semi-technical: they ask "what if we used Grok instead of Omni?" or "what if we
changed this bit of the prompt?" and they need you to know what the bits *are*.

**Ground yourself first, every time:**

```bash
node scripts/rpd/rpd.js prompt                      # video elements + meaning + current text
node scripts/rpd/rpd.js prompt --kind static        # static blocks
node scripts/rpd/rpd.js prompt --key transitions    # one element in full + a paste-ready variant
```

**Never describe or rewrite a prompt element from memory.** These strings change,
and one of them is deliberately self-contradictory in a way that reads like a bug.
Run the command, quote what it actually says, then propose against that.

---

## What we are actually optimising for

Owner-stated: Meta + PMax ads from a real merchant product photo. Static ads place
the REAL product into **lifestyle and studio** scenes with the product pixel-faithful.
Video brings a **static photograph to life** — camera motion over the real photo,
product never altered. Copy must render faithfully. Judge every suggestion against
that, not against "nicer video".

---

## Video elements (`spec.variants[].directives`)

| element | what it controls | recommend? |
|---|---|---|
| `cameraStyle` | motion character and amount | **Yes — first lever.** Evidence favours LOW motion for fidelity: `slow push-in`, `subtle parallax`, `static product, camera only`. |
| `transitions` | cut vs dissolve policy | **Yes — measured win.** "Hard cuts only" removed the ghosting we saw at ~1.2s/~2.5s in the baseline. Read the contradiction note below first. |
| `objective` | what the ad is FOR | Yes for pacing/attention. The PMax profile already adds HOOK-FIRST here; worth testing on Meta. |
| `visualStyle` | the look — ecommerce polish vs lived-in | Yes, and it is the most direct lever on **studio vs lifestyle**. |
| `background` | may the scene be extended/replaced | Situational — relevant when a packshot needs a scene built around it. |
| `productPreservation` | the fidelity core | **Careful.** Weakening invites drift. Strengthening has *not* been shown to fix the known defect (see the ceiling note). |
| `physicalAccuracy` | hands/faces sanity | Only matters with a person in frame (on-model shots). |
| `role` | persona framing | Low yield. |
| `sourceImages` | the locked-photo rule | Do not weaken. |
| `audio` | ambience only, no music/VO | Low value — we do not use generated audio. |
| `doNot` | the ban list | Paired with `transitions`; read the contradiction note. |
| `noText` | forbids in-model text | **DO NOT REMOVE.** See below. |
| `ambientLife` | lifestyle profile only: incidental world motion | Only in the `lifestyle` profile. |

Profiles: `gemini-omni` (default), `grok`, `pmax`, `lifestyle` — `--profile <name>`.
The profile is chosen by the model's paramShape and the platform format, so a PMax
destination gets PMax directives automatically.

## Static blocks (`spec.static.variants[].blocks`)

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

**1. The crossfade/dissolve contradiction is DELIBERATE.** `transitions` permits
"Smooth crossfades only, ~0.25s" while `doNot` bans "dissolves" — and a crossfade
*is* a short dissolve. The owner confirmed that contradictory version produced
better output; PR #61 "fixed" the video prompt and was rolled back in full. So:
changing the transition policy as an *experiment* is legitimate and measured well.
"Cleaning up the inconsistency" is reintroducing a known regression. Say which one
you are proposing.

**2. `noText` must stay.** Titles are composited afterwards by Remotion, per
surface, with that surface's safe zone. If the model renders text, it is burned into
the pixels and cannot be retitled for Reels vs Stories vs feed. Anyone asking for
"add the headline into the video" wants the titling path, not this prompt.

**3. Prompt tuning has a ceiling here.** An independent July 2026 benchmark found
even the leading image models preserve *complete* product detail in only ~29% of
generations. Our own ~1-in-3 competitor-mark defect is in line with that. So a
fidelity complaint is usually **not** solved by more forceful prompt wording — the
real fix is measure-and-reject (`adVisionQcService`). Recommend a prompt experiment
when the goal is motion, pacing, look or scene; recommend a model swap or QC when
the goal is fidelity.

---

## "What if we used Grok instead of Omni?"

Run `node scripts/rpd/rpd.js models` for the live registry and floor estimates, then:

- **Both are already runnable** — `xai/grok-imagine-video-v1.5/image-to-video` is
  registered and selectable. So this is a one-line spec change, not a code change.
- **Grok's rate is UNVERIFIED** in the registry: the estimate exists so the budget
  gate can sum it, but unlike Omni developer (which measures ~33% *under* its
  formula) the error direction is unknown. Keep the first Grok run short and read
  the settled price back.
- **Grok i2v takes ONE reference image**, Omni takes up to 7. Extra refs are
  reframed and then discarded on Grok, so a multi-ref comparison is not apples to
  apples — say so rather than reporting it as a quality difference.
- **Prompt byte cap differs** (Grok 4096 vs Omni 20000), so the same directives can
  drop lines on Grok. The harness errors rather than silently truncating.

The wider field: 79 image-to-video models exist in the Atlas catalog and we have 5
registered. Adding one is a `MODEL_CAPS` entry plus a measured price — see
`references/operations.md` and the latest opportunity scan in `claude-org-brain`.

---

## How to run a good comparison

- **One variable per arm.** Baseline + one change. Two changes in one arm means you
  learn nothing about either.
- **Dry-run first — it is free** and prints the exact prompt per cell, so the tester
  sees precisely what will be sent before any money moves.
- **Pick a hard product.** A printed logo or busy label IS the test; a plain object
  will pass every arm and teach nothing.
- **n=1 proves very little.** Our block-swap result was a null at n=1/arm and is
  recorded as a null, not a win. Say this before someone concludes from one image.
- **Ask for the budget.** Never invent `--max-usd`; the human sets it.
