# DECISION: Frame-native typography, with the plate directed to leave room for it

---

## 1. THE CALL

**Ship native typography rendered in the video frame's own coordinate system. Direct the video model to leave a hole for the words. Use a vision pass to find out where the words must *not* go. Delete the gpt-image-2 title-card path.**

Concretely, three coupled pieces, in this order of confidence:

1. **Reserve the space up front (free).** The creative director already picks a "shot archetype" per concept — `typographic_dominant`, `vertical_split`, etc. — and already tells the video model things like "generous negative space." That instruction is currently computed and then thrown away: the word `archetype` appears nowhere in the titling code or the Remotion renderer. Turn it into an actual rectangle in frame coordinates, put that geometry into the video prompt, save it on the ad, and hand it to the titler. Plate and typography become one composition instead of two layers fighting.

2. **Render the words natively, in frame coordinates.** Two tiers. The existing DOM slot system stays the default and the floor — it already owns brand fonts, safe zones, WCAG contrast flipping and staggered reveals, and it produces better-looking output than the image model does today. On top of it, add one full-frame vector layer for the hook phase, authored in the frame's own 1080×1920 (or 1080×1350 / 1080×1080 / 1920×1080) coordinate space. That layer is where mixed weight in a single line, tight leading, negative tracking and poster-scale type become possible — none of which the slot system can express (leading is hardcoded at 1.16, tracking clamps at zero-or-positive, headline type caps around 136px, one weight per slot).

3. **Tell the renderer where not to put words (~$0.002–0.012 per render).** There is already one multimodal call per video that looks at sampled frames of the generated plate and returns three booleans per band. Widen that same call's answer to return normalized rectangles — face, product, printed text, and critically **logo/wordmark** — and let Node do deterministic geometry from there. This is the only piece in the whole exercise that addresses the actual defect in the frame everyone keeps citing: the chest logo running through the words.

**The gpt-image-2 title-card code: DELETED, with two things harvested first.**

Delete `directorTitleCardGenerate.js`, `directorTitleCardService.js` (generation, prompt, and the spec-injection that hides real slots), `TitleCardSlot` in `slotRenderers.jsx`, the `titleCard` slot key in `titleSpecValidator.js`, the prep/materialize hooks in `remotionRenderService.js`, and the `ADGEN_DIRECTOR_TITLE_CARDS` flag. Abandon the `fix/director-title-cards` branch rather than merging it.

Harvest before deleting: (a) the per-phase **reference-frame extraction** in `plateIntelService.js` (`hints.directorFrames`) — the new vector director needs to see the plate, and that code already extracts and encodes exactly the right frames; (b) the **copy-fidelity prompt discipline** (arrow notation, fenced ABSENT sentences, and the explicit "no fake paper, no scrim, no drop-shadow plate" ban) as the template for the new layer's copy and style contract.

This deletion costs no production behaviour. The flag is `false` in both repos with no dashboard override found. Nobody is using it.

---

## 2. WHY

**Why the image-card path dies.** I had four delivered frames opened and measured rather than described. Three of four are unshippable: one has the brand's own chest logo punching through the headline with 55% of the frame empty below; one composites a literal grey transparency checkerboard as visible pixels; one contains a light box over the model's midsection with copy rendering at roughly 10px in a 1080-wide delivery. The fourth — the raw card — is flat white system-sans, flush left, ragged right, with an arbitrary size hierarchy.

That last point is the one that actually settles it. **The reason someone reached for an image model was to buy art-directed typography, and the artifacts show it never arrived.** Worse, the bitmap architecture structurally throws away three things the free path already has: the brand's real licensed typeface (a prompt can only *name* a family — Gymshark came back in Helvetica), per-item staggered reveal (a card is one flat static image in a 10-second video), and the entire adaptive-contrast system (the card slot receives no color tokens and no frame dimensions, which is exactly why that white-on-pink headline sits at about 2.3:1 contrast with no stroke).

And the geometry is unfixable by any model in the catalogue. All 123 image models on Atlas were checked: zero expose regional prompting, bounding boxes, or any coordinate for generation. The card is generated at 1024×1536 and then letterboxed into a group box that is roughly 11% of frame height. Measured on the real artifacts, the model's own 4.5% right margin became a 30.2% right margin — multiplied 6.7×. No prompt phrased in percentages can correct a transform that depends on anchor, safe zone, format and a runtime fit scale, none of which the prompt knows.

**Why "swap to a better image model" (score 13) loses.** It fixes the alpha/checkerboard defect and nothing else — it says so itself. Its causal story also does not survive its own data: 5 of 9 cards came back with clean alpha from the *same* model with the *same* parameters, so the failure is stochastic and correlates with the prompt (which contains a literal "fully transparent PNG" prose line — exactly the sort of instruction image models render *as* a checkerboard), not with the model. And on like-for-like published pricing, the proposed model is 3.6× *more* expensive. It also missed a cheaper same-family variant sitting in the very code comment it quoted.

**Why "LLM authors a spec" (score 17) loses as the whole answer, but wins a critical detail.** Its ceiling is verifiably too low: the slot system cannot set two weights in one line, cannot tighten leading, cannot use negative tracking, and caps headline size at or below the reference frame's own type. Those four things *are* what makes display typography read as designed. It also leaves the logo collision — the most visually obvious defect — explicitly unsolved while leading with the least visible one.

**But it is right about one thing that fixes the winning design.** Its cited precedent (`videoBenefitsDirector`) makes its LLM call at *mint* time and runs only a pure function at the render seam. Any generative call that sits inside the render path inherits up to eight paid upstream attempts and 11–16 minutes of worst-case wall clock on a claimed ad, and forfeits memoization entirely because the memo is an in-process Map on an autoscaling service. **So: the vector-layer director call moves to mint time, memoized per (brand, format, funnel stage).** That single change fixes latency, cost and campaign consistency at once — the same look gets reused across an ad set instead of six ads each looking like a different designer.

**Why "hybrid decorative" (score 19) loses, and what survives.** Its first increment puts textured background rectangles behind text — which is precisely what a standing owner directive bans. That rule has eight in-code citations and has been enforced by *removal* on delivered ads twice; 431 of 431 preset slot treatments are `scrim: none`, with no exception. The materials it proposes (torn paper, kraft, tape) are banned verbatim in the existing prompt. It would be rejected on sight.

**What survives from it, and it matters:** the `@remotion/shapes`, `@remotion/paths` and `@remotion/noise` packages are installed with zero imports anywhere. A warped, hand-drawn-looking circle or underline built from those is free, deterministic, and a natural extension of the accent axis the design system already sanctions. That is deferred, not discarded. It also correctly identifies that ornament behind type, unable to touch either the words or the subject, is wallpaper — which is why it loses and the frame-native approach wins.

**Why "vision-directed native" scored highest (20) but is not the headline.** Its economics and engineering are the most solid of the five, and its keep-out-rectangle mechanism is the right one — I am taking it wholesale. But its placement objective is wrong: "find the largest empty rectangle" is a legibility metric, not a compositional one. On exactly the plate type this pipeline generates most (single subject, clean backdrop), the largest empty rectangle is the big dead lower half. It would pull the headline off the chest and float it dead-centre in a void — technically correct, creatively indefensible.

**The fix, which is why the reservation idea leads:** don't search for empty space, *reserve* it in advance and then verify it. The reservation gives a compositional intent (chosen by the creative director, honoured by the video prompt); the keep-out rectangles verify compliance and veto collisions. Rectangles become a safety check, not a layout algorithm.

**One more graft, from a reviewer rather than a proposal.** Two lanes wanted `@remotion/layout-utils` for deterministic text measurement. It is browser-only, and the copy-length logic must also run in Node — so that path forces a dual measurement scheme that reintroduces the exact estimator/paint divergence it was meant to remove. **Use `@napi-rs/canvas` instead**: already a dependency, already used for real text measurement elsewhere in the repo, with 17 local font files on disk. Same win, server-side, deterministic, no split brain.

---

## 3. WHAT SHIPS FIRST

**One day. Zero dollars. One question: does hand-authored vector type on the real plate obviously beat the shipped card?**

Everything above rests on the belief that native/vector typography can look art-directed. Nobody has ever tried, so nobody knows. Do not build a generator to find out.

1. Add a `titleLayer` slot: one full-frame absolutely-positioned sibling in `liquidretail_adgen/src/remotion/compositions/Canonical.jsx`, inserted between the base plate and the group map (around line 427), rendering a raw SVG string at the composition's exact viewBox. It deliberately bypasses the group/stack/fit machinery — that bypass is the entire point. Register the key in `src/services/titleSpecValidator.js` (`SLOT_KEYS`, `SLOT_TYPE_BY_KEY`).
2. **Hand-author three SVG title layers.** No model, no spend. Use the real copy ("The top for your run and your coffee run"), the real brand tokens, and the fonts `src/remotion/components/FontLoader.jsx` already installs. Put the copy in the lower third the plate actually left empty. Use the things the slot system cannot: two weights in one sentence, tight leading, a real rag.
3. Render through `scripts/renderTitlePreview.js` — the existing offline harness. **Pass `plateHintsOverride`**, or the shipped `TITLE_PLATE_SCAN=gemini` default will make an otherwise-free run billable.
4. Input plate: `/Volumes/Sayulita/Projects/RS/.wt-director-title-cards-fix/title-preview-output/after-prompt-fix/6a9c65e6fb5073eec0cb50c8-titlecards.mp4`. Compare against `..._f155.png` from the same directory.
5. Put both in front of the art director.

**Kill criteria, stated in advance.** If hand-authored vector type on that plate is not obviously better than the card, the whole "we need generated typography" premise is dead. The correct action then is to delete the title-card path anyway (it is off, so this costs nothing) and spend the effort on presets — where there is measurable unspent range: zero of 431 preset slots use a scrim, the `bar` accent is never used, horizontal offset is zero in every preset, 10 of 21 slot types are never authored, and the six curated brand presets are used by zero of seven live brands.

Free bonus: serializing those three hand-authored SVGs gives an exact output-token budget for the generative phase later, replacing an estimate with a measurement.

---

## 4. THE PHASED PATH

| Phase | What | Cost | Ships alone? |
|---|---|---|---|
| **0** | Hand-authored SVG kill test (above) | $0 | Yes |
| **1** | Thread archetype → reservation rectangle into the video prompt, persist on the ad, pass to the renderer. Delete the title-card code. | $0 | Yes |
| **2** | Replace the character-width guess with real server-side measurement via `@napi-rs/canvas`. Fixes a wrap bug the codebase already documents. | $0 | Yes |
| **3** | Widen the existing plate-scan call to return keep-out rectangles including a `logo` class. **Observe-only** — log and paint them, change no placement. | ~$0.03 total to validate | Yes |
| **4** | Reservation-compliance scoring from frames ffmpeg already extracts; veto placement that collides with a returned rectangle; fall back to today's behaviour on any doubt. | $0 | Yes |
| **5** | Generative vector layer: one director-role call **at mint time**, memoized per (brand, format, stage), validated, fail-closed to DOM slots. | see below | Needs 0–4 |
| **6** | Optional: native ornament from the installed shapes/paths/noise packages, as an extension of the sanctioned accent axis. | $0 | Yes |

Two hard constraints carried into Phase 5's design, both learned from lanes that lost:

- **The SVG grammar must forbid filled background rectangles behind text.** Otherwise the model will invent scrims, and scrims are banned by standing directive and have been removed from delivered ads twice.
- **The copy assertion must not whitelist `path`.** Vector-outlined lettering carries no readable text and would slip straight past a "the words must match exactly" check.

Also: `safeZones.js` is byte-identical across two repos and must stay that way, and any Brand model field must land in the backend repo first — a parity check enforces the subset relationship.

---

## 5. WHAT THIS COSTS

**First, the baseline in the brief is not real.** The title-card flag is `false` in production. Today's typography spend is **$0.00 per video**, not $0.12. We are not saving money; we are deciding never to start spending it, plus adding a small new line item.

**What the card path would have cost if switched on.** The only measured figure in the code is $0.07173 per image edit (40 live calls), so 3 cards is **$0.215 per ad**. But the real unit is per *product*: one paid video plate mints roughly 12 Meta video ad rows, every one of them flagged non-billable as a deliberate money invariant, and the card cache is per-ad so nothing is shared. That is 36 billable image generations — **$2.58 per product**, against a plate costing roughly $0.90–1.04. Titling would have cost more than the video.

**What this architecture costs.**

- Phases 1, 2, 4, 6: **$0.00.** No new model call anywhere. Video pricing is per-second or flat, so a longer prompt is free.
- Phase 3 (keep-out rectangles): widening a call that is *already billed on every render*. Roughly +150 input and +900 output tokens on a cheap vision model: `150 × $0.30/M + 900 × $2.50/M ≈ $0.0023`. Allowing 2–5× for reasoning tokens, which bill at the output rate and are on by default: **$0.005–$0.012 per render**, so about **$0.06–$0.14 per product**.
- Phase 5 (vector director at mint): ~3,500 input tokens at $2/M = $0.007, plus a realistic 3,000–5,000 output tokens at $10/M = $0.030–$0.050. **≈ $0.04–$0.06 per call.** Memoized per (brand, format, stage) — roughly 6–12 keys per product — that is **$0.22–$0.68 per product**, or **$0.02–$0.06 per video**.

**Bottom line:** steady state ≈ **$0.03–$0.07 per video / $0.30–$0.80 per product**, versus **$0.215 per ad / $2.58 per product** for the card path. Three to eight times cheaper. And Phases 0–4 — which may be most of the quality win — are genuinely free.

**Latency is the bigger win and nobody costed it.** Cards generate strictly serially: three sequential image calls, polled every 3 seconds with a 180-second ceiling each, in front of a measured 76-second render. That is 60–135 seconds typical and up to 9 minutes worst case, per ad. The new path adds nothing to the render path: the reservation is free, the rectangle call is inside a request already being made, and the vector director runs at mint.

**Honest caveat:** against a $0.90–$5.00 plate, no titling figure here is decision-grade. **Do not choose this for the money.** Choose it because it deletes three defect classes by construction (invented copy, card-space-vs-frame-space, alpha artifacts), removes up to two minutes of per-ad latency, and produces output that is deterministic, diffable and reviewable in a pull request instead of a fresh gamble every render.

---

## 6. WHAT I AM STILL UNSURE ABOUT

Ranked by how much damage being wrong would do.

1. **Does hand-authored vector type actually look better?** Unproven. Everything rests on it. The image model demonstrably failed to deliver art direction, but "the incumbent also fails" does not prove the replacement succeeds. **Settle it in Phase 0, for $0, in one day.** If it fails, the honest answer is to delete the card path and invest in presets.

2. **Can a vision model return a *tight* rectangle around a small, low-contrast logo?** The existing quality judge already detects competitor marks well enough to gate shipping — but "there is a mark on the product" is a far easier question than "the mark occupies these four coordinates." If the box comes back loose, the solver over-avoids; if it is missed, we have reproduced today's defect at a new cost. **Settle it in Phase 3 for about $0.03** across the six plates already on disk: observe-only, paint the boxes, look at whether the logo box lands on the chest mark. Hard pass/fail.

3. **Do video models actually honour a reservation rectangle?** Video models are weakly steerable on composition. If compliance is poor, Phase 1's value collapses to whatever the compliance check salvages. **Settle it for $0** by scoring the reservation region on frames already extracted from plates already generated.

4. **Will the cheap vision model hold a richer JSON schema?** There is an in-repo counter-precedent: the cheap model broke the JSON contract on a similar vision task, the role was moved to the expensive one, and the comment explicitly says not to restore it on price. If precision forces the upgrade, per-call cost rises roughly 4×, which is still under the card path. Phase 3 measures the parse failure rate directly. **Related, and easy to get wrong:** the existing call has a 1,024-token response cap — a richer answer will silently truncate, fail to parse, and quietly degrade to the basic hints that work today. Raise the cap in the same change.

5. **Output token count for the vector layer.** I am estimating 3,000–5,000. The lane that proposed it estimated 1,500 against a template capped at 800. **Phase 0 measures it exactly** by serializing the hand-authored versions.

6. **Campaign consistency of generated SVG.** Per-render generation would let six ads in one ad set each look like a different designer, and a mixed campaign of bespoke and fallback layouts looks broken. Mint-time memoization is the mitigation and is a design requirement, not a cost optimisation. Unvalidated until Phase 5.

7. **Two things I could not check and did not guess.** No Render dashboard read was performed, so a production override of the title-card or plate-scan flags cannot be ruled out — one dashboard glance settles it. No database read was performed, so it is unknown which brands carry custom fonts, style presets or saved specs. That second one matters more than it sounds: brand font overrides resolve free through an existing ten-tier resolver and are the single strongest art-direction lever in the stack. If the answer is "no brand has any," the free upside is larger than anything in this document. **One query settles it.**

8. **What this does not fix, stated plainly.** Even with rectangles, a low-contrast grey mark on flat fabric may not be detected, and the reservation check can be fooled by it — a smooth surface reads as calm. This lowers the probability of the chest-logo collision substantially; it does not eliminate it. Anyone who promises otherwise has not looked at the pixels.