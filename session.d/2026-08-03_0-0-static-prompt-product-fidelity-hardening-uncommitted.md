## 0.0 STATIC PROMPT — product-fidelity hardening (2026-08-03, UNCOMMITTED)

Owner-directed. Targets **product drift** on the gpt-image-2 direct static path:
hallucinated logos, shifted colour, altered fit, "improved" construction.

**There is ONE prompt builder, not three.** The owner expected three; the three are the
three *intents* (`social_proof_led`, `product_first_lifestyle`, `objection_resolved`),
which all share `staticAdIntents.buildPrompt`. Hardening that one function covers all
three. `aiImageReferenceService.buildPrompt` and `aiLayoutStudioService.buildGenerationPrompt`
are also gpt-image prompts but are **not** on this path (shadow artifact, default
`AI_IMAGE_REFERENCE_ENABLED=false`; and layout exploration never delivered as an ad) — both
were deliberately left alone.

**Changed** (`services/staticAdIntents.js`, `+133`):
- `PRODUCT_FIDELITY` — replaces the one hedged sentence that was losing to the creative
  instructions below it. Source-of-truth, no category/brand-prior inference, preserve
  form / construction / surface / colour / on-item graphics / details / condition, a NEVER
  list, a hidden-geometry rule, an explicit WHAT MAY CHANGE list, and a closing check.
- Carve-outs in `absences` and both `textBlock` branches so the no-added-text rules cannot
  strip the product's **own** printed label. That conflict **predates** this work: those rules
  ban marks "on packaging or clothing within the scene" and on this catalog the product often
  IS the packaging or the clothing. Every carve-out is anchored to *"visible … in the reference
  photograph"*, never *"on the product"* — the loose phrasing lets a model invent a label it
  believes the product normally carries.
- `absences` also generalised off apparel ("garment" → "product").
- Stale comment fixed at `directImageRenderService.js:706-712` (it quoted the deleted sentence).

**Kill switch `STATIC_PROMPT_FIDELITY_HARDENING` (default true).** `false` restores a
**byte-identical** pre-hardening prompt — block *and* both carve-out sites revert together,
verified by diffing all six intent×surface prompts against a pre-change dump. Partial revert
would give an A/B whose control arm is not the arm that was measured. Precedent: PR #61
hardened the VIDEO prompt and the owner rolled all three parts back (CLAUDE.md §00).

**THE RISK, unmeasured and the reason the flag exists.** The prompt more than doubled,
**~3.5-4.1k → ~7.8-8.4k chars**, and the block sits **above** `SET EXACTLY THESE STRINGS` on
a path whose measured text fidelity is **139/140 strings across 20 renders**, and where
`quality:high` already measured WORSE than `medium` *by losing a string*. Mitigations applied:
the precedence sentence explicitly exempts the text contract and defers to the reserved-corner
rule, and the closing check covers copy as well as product. **First render sample after this
lands: check copy fidelity before anything else. If strings degrade, flip the flag.**

This does **not** fix the ~1-in-3 competitor-mark defect and must not be described as fixing
it — `adVisionQcService` (measure-and-reject) is still that fix. See CLAUDE.md §2 Known open.

**Verify:** `scripts/verifyStaticFidelityPrompt.js` — 419 checks, both arms, revert-proven on
three mutations (hardwire flag off / delete the text-exemption clause / loosen the reference
anchor); all three fail the harness. Full suite **46/46 green**.

### 0.0a PRICING CORRECTED — `base_price` is not the charge (2026-08-03, MEASURED)

Found by running live renders. **`price.actual.base_price` under-reports the real charge
by ~7.17x.** CLAUDE.md §2, `docs/ATLAS.md` and the `buildPriceMap` comment all said
`actual` "is what we pay"; all three are now fixed.

| model | catalog base | **measured charge** |
|---|---|---|
| `openai/gpt-image-2/edit` | $0.010 | **$0.07173** |
| `openai/gpt-image-2-developer/edit` | $0.005 | **$0.03586** |

Dead-consistent across every priced prediction. The multiplier is **not** in the catalog
and was measured only at `1024x1024` / `quality: medium` — do not hardcode it or carry it
to another model. `buildPriceMap` is a **floor-grade estimate** whose only job is to stop a
$0.00 row.

**Owner rule: always read the actual price back from Atlas after generation.** Authoritative
figure = `price` on the **settled** prediction (`GET /model/prediction/:id`). Atlas usually
publishes it *after* the image returns — measured **7 of 38** had it at completion — so
`scheduleCostReconcile` is the normal path, not a rare top-up. Its budget was widened
`[3s,10s,30s]` → `[3s,10s,30s,60s,120s,300s]`; at the old budget most rows kept a 7x-low
estimate forever, which is how a static ad appeared to cost $0.01.

### 0.0b STATIC EDIT MODEL — switched to `-developer`, then REVERTED same day (owner, 2026-08-03)

**FINAL STATE: `openai/gpt-image-2/edit` (the plain variant).** Both `PLATE_EDIT_MODEL`'s code
default and `AI_DIRECT_IMAGE_EDIT_MODEL` in `config/defaults.env` point there.

The `-developer` variant was adopted for its 50% discount and reverted hours later on measured
reliability:

| variant | submits | hard `prediction failed` | rate |
|---|---|---|---|
| `-developer` | 76 | **13** | **17.1%** |
| plain | 38 | **0** | 0% |

Three independent developer runs failed at **15.8% / 15.0% / 22.2%** — consistent, not a bad
afternoon. Each failure is a BILLED submit returning `outputs: null` with no error message,
which reaches the operator as a failed ad and bills a failure. Cost per SUCCESSFUL render still
favoured developer ($0.0426 vs $0.0757), so **this was deliberately not a cost decision** — the
owner chose delivered ads over unit price. Re-measure before reaching for `-developer` again.

The original switch rationale below is kept because the schema/price comparison is worth having
on record.

### 0.0b-orig The `-developer` switch, as originally written

`PLATE_EDIT_MODEL` default and `AI_DIRECT_IMAGE_EDIT_MODEL` in `config/defaults.env` both
now point at `openai/gpt-image-2-developer/edit`. **Halves static spend** — a 3-surface
`meta_static` fanout goes ~$0.215 → ~$0.108 per product. Submit COUNT is unchanged.

Verified live before switching (never take a model id from memory): both ids resolve to the
same `POST /model/generateImage` and their request schemas are **field-for-field identical**
— same `required`, same 14-value `size` enum, same `quality` enum, neither exposes
`input_fidelity`, and they share one `readme`. Drop-in; `buildParams` unchanged. The
identical `size` enum is why `verifyStaticSafeBox` still passes — noted in that file.

⚠️ **NOT verified: output quality dev vs non-dev.** The A/B ran both arms on the developer
model, so it compares prompts, not models. Revert path is `AI_DIRECT_IMAGE_EDIT_MODEL=openai/gpt-image-2/edit`,
no code deploy.

### 0.0i THE PLATE WAS NEVER ASKED TO LEAVE ROOM (2026-08-04) — read before §0.0h

**SHAREABLE REPORT: https://ad-typesetting-split.pages.dev/** (Cloudflare Pages project
`ad-typesetting-split`; rebuild with `node buildsite.js` then `wrangler pages deploy site
--project-name=ad-typesetting-split --branch=main`). Every number on that page is read
off a measurement file, never hand-typed.

**MERGED. `origin/main` is `8d8a48c`** — the 8-commit static hardening branch plus the
pricing correction went in on owner instruction. Only `session.md` conflicted; all code
auto-merged. Verified ON THE MERGED TREE (not just the branch): `verifyStaticFidelityPrompt`
736, `verifyStaticSafeBox` 334, `verifyCoherentSocialProof`, `verifyQuoteProvenance` — all
pass. So the hardened prompt and `STATIC_PROMPT_FIDELITY_HARDENING=true` are now trunk.

#### The omission, owner-spotted

Owner: *"we haven't asked the image call to make space for the copy like we would in
production correct?"* Correct, and worse than an omission. The genuine no-text branch
(`staticAdIntents.js:699`) ENDS with `The photograph alone has to do the work.`, which
pushes the model toward a self-sufficient filled frame, and `PRODUCT SCALE AND FRAMING`
pins the product's share of frame. **Every plate in the §0.0h bake-off was composed as a
complete photograph, so the compositor was hunting for clean regions that never existed.**
All earlier composited-type results silently carried that handicap. Note the architecture
already reserves a corner so a real logo can be composited — it was simply never extended
to copy.

**MEASURED with a band scan** (`cleanband.js`, zero cost — slides a 20%-height window down
the safe box, scores evenness and value, "usable" = spread ≤28, mean outside the 110-138
dead zone, best ink ≥4.5:1):

| plates | usable band | median usable bands/plate |
|---|---|---|
| OLD, no space asked for (16) | 4/16 | **0** |
| NEW, reservation clause (8) | 4/8 | **4** |

The median is the real signal: when the clause lands the model opens most of the frame;
when it misses it misses completely. **Still only ~half obey it** — `flutter` came back very
dark but BUSY (spread 31-32), `campus-02` landed at mean 112 (inside the dead zone the
clause explicitly warns about), `shoe-02`'s quietest band was spread 64. A plate without a
usable band is DETECTABLE BEFORE any typesetting spend, so the fix is regenerate-on-fail.

**How the clause is applied, and why it must be a REPLACE:** `platespace.js` builds the
genuine prompt then substitutes the closing sentence. Appending would leave "the photograph
alone has to do the work" next to "leave room for text" — the same self-contradiction that
made an earlier spliced prompt fabricate proof claims in 8/8 plates. Both directions are
asserted: the old sentence must be found (ABORT otherwise, so an upstream rewording can
never let it silently no-op) and must be gone afterwards.

#### Results on plates that have room

`gpt-image-1.5/edit` + `input_fidelity:high`, 4 seeds × 2 plates. **MEASURED $0.3468 for 8
plates = $0.04335 each** (all 8 priced after reconcile). That is 50% above the $0.23 I
estimated, so **1.5 is ~40% cheaper than gpt-image-2's $0.07173, NOT 62%.**

Two director arms, owner-chosen: `gpt-5.4` direct, and `xfer` (gpt-5.4 shown gpt-image-2's
own finished ad as the typography exemplar). **16/16 composites, 48/48 elements clear
4.5:1, zero failures**, 11 inks corrected by the renderer. The arms differ in hierarchy:
gpt54 makes the QUOTE largest (52-68px), xfer makes the RATING largest and pins the quote
at 46px on every single plate — it is anchoring to the exemplar's scale.

⚠️ **ASPECT IS 2:3, NOT 9:16.** Verified live against the schema: `gpt-image-1.5/edit`
offers only `1024x1024 / 1024x1536 / 1536x1024`. The prompt's own FORMAT block declares
1152×2048, so plate geometry and declared geometry disagree. Unavoidable on this model.
The §0.0h composites have the same mismatch and I mislabelled them 9:16.

**Also fixed:** `typeset2.js` ink fallback is now ranked over pure `#000000`/`#ffffff`
instead of branching on `#12161c` — that is what took the 192-element cross-apply from 9
failures to 0. `crossapply.js` is the harness; `rerender.js`/`buildsite.js` are zero-cost.

**STILL THE GATE:** the aesthetic call. Exactness is settled — composited copy is exact by
construction and 4.5:1 is now guaranteed on any background. Whether it looks shippable next
to gpt-image-2's own typesetting is the owner's judgement and no production code should be
written before it is answered.

### 0.0h TYPESETTING SPLIT — where it actually got to (2026-08-04)

Still an EXPERIMENT. No production code written. **Its plates carried a handicap that
§0.0i identifies — read that first, and treat the contrast conclusions here as superseded.**

**OWNER ANSWER that reframed it:** the 2026-07-31 overlay retirement was about
**TYPOGRAPHY**, not placement. And **"I hate the scrim. no scrim!"** — panels are banned
outright, so legibility must come from position and ink colour alone.

**PLATES ARE SOLVED.** The genuine no-text path (empty `data` on `meta_stories_9_16`,
the one surface with `drawCta:false`, so goal/emphasis/absences all adapt) produced
**16/16 clean text-free plates across two image models, zero fabricated proof.** The
earlier 8-for-8 invention of ratings and review counts came ENTIRELY from a
self-contradictory spliced prompt, not from the models. Product fidelity on
1.5+`input_fidelity:high` plates is excellent.

**BRAND FONT PIPELINE WORKS.** PELAGIC's real face (Archivo Variable) pulled from their
Shopify CDN — `@font-face` in the homepage HTML, `/cdn/shop/t/587/assets/` — converted
woff2→ttf with fontTools in a venv, registered via a local `FONTCONFIG_FILE`. Renders
correctly including the ★ glyph. **Gymshark's face was NOT obtainable** from their site,
so the Gymshark rows use Archivo too — not brand-accurate, fine for comparing direction.

**FOUR ARMS × THREE BRANDS, all rendered:** `gemini-3.5-flash`, `gpt-5.4`,
`claude-sonnet-5`, and a STYLE-TRANSFER arm (gpt-5.4 shown gpt-image-2's own finished ad
as the typography exemplar plus the target plate — the owner's idea, and the arm that
produced the most confident scale).

**WHAT THE RENDERER HAD TO OWN, because the models got it wrong:**
1. **Ink colour.** All arms chose white regardless of background; **8 of 11 elements
   failed 4.5:1 contrast.** The renderer now measures luminance under the real ink box
   and overrides to near-black/white only when the model's own choice is below 4.5:1.
   Result: **9/11 fully legible, up from 3/11.**
2. **Scale.** sonnet and gemini specced 14–36px type on a 1536px frame — captions, not
   ads. One PROPORTIONAL lift keyed off the quote (floor 3% of height, cap 2.6x), so each
   model's own hierarchy survives instead of being clamped flat.
3. **Text measurement.** v1 estimated widths from character counts, which is why panels
   didn't fit and baselines collided. Now every line is rendered and trimmed to its real
   ink box; the renderer owns wrapping and the model never gives a baseline.

~~⚠️ **THE NO-SCRIM CONSTRAINT IS NOT ALWAYS SATISFIABLE.**~~ **WRONG — RETRACTED
2026-08-04, see §0.0i.** The two failing cells were not evidence of an unsatisfiable
constraint, they were evidence of a bad fallback palette. The dark fallback was
`#12161c`, a designer near-black whose own luminance only clears 4.5:1 from background
≥126.3, while white clears it up to ≤118.7 — which MANUFACTURES a dead zone at
118.7..126.3. Pure `#000000` clears from ≥116.1, which OVERLAPS white's range, so every
background is coverable and there is no dead zone at all. Re-measured over 192 elements:
9 failures became **0**. Do not re-derive the "unsatisfiable" claim from those two cells.

**OPEN AESTHETIC QUESTION — the owner's, and it is not settled:** *"I still think the
GPT2 images might have looked better."* `final-compare.jpg` puts gpt-image-2's own
typesetting in column 1 against all four composited arms. That judgement is the gate for
whether any of this gets built. Nobody should write production code before it is answered.

**Scratchpad additions:** `typeset2.js` measured/flowed/no-scrim compositor (exports
`compose`, `measure`, `contrastUnder`) · `bakeoff.js` four-arm driver · `rerender.js`
re-renders from saved specs with ZERO API calls · `bake/specs.json` all 11 specs ·
`bake2/` fixed composites · `final-compare.jpg` the decision sheet · `fonts/`,
`fc/fonts.conf` the brand-font setup · plates in `samples14/16/17`.

Session spend ≈ **$18.90** — no further image calls were made after this point.

### 0.0g HANDOFF — 2026-08-04. NOTHING IS MERGED. Read this first.

**MERGE STATE: 6 commits on `feat/static-product-fidelity-hardening`, tip `8e655aa`, PUSHED but
NOT merged and NO PR open.** `origin/main` is at `bee82b7` and does not contain any of it.
Production therefore still serves the LEGACY prompt with the permissive person clause on
`gpt-image-2/edit`. Everything below is unshipped.

Commits, oldest first: `bb81717` hardening v1 + kill switch · `63e9d39` pricing correction +
prompt v2 · `f11934a` revert to non-dev model · `9f8c6f3` person rule · `8686398` identity +
compression · `8e655aa` revert compression, keep one simple identity sentence.

**The pricing fix in `63e9d39` is a correctness bug independent of all the prompt work** —
`base_price` under-reports the charge ~7x and `scheduleCostReconcile` gave up too early. That is
worth merging on its own merits even if every prompt change is rejected.

#### OPEN EXPERIMENT — split the typesetting from the glyphs

Owner's goal: keep `gpt-image-2`'s typesetting *judgement* without letting any model draw the
glyphs. Driver is the trade in §0.0f — `gpt-image-1.5/edit` + `input_fidelity: high` gives
**0/12 model swaps and is 62% cheaper**, but breaks the rating string (fabricated counts, a wrong
`4.4` for 4.6).

**THE CONSTRAINT:** any pixels a model produces for text carry its error. A returned "mask with
copy" is still model-drawn letterforms. Model output is usable as **position and styling only**.

**PRECEDENT, and it is strong:** this pipeline already does exactly this for the LOGO —
`directImageRenderService` reserves a corner, forbids the model drawing any logo, and composites
the real asset locally (`logoPlacementFor` + `layers.push`, `:935-971`). A misspelled rating is
the same defect class and worse, because it is a proof claim. Extending that slot to the rating
is the smallest viable version.

**Arms:** A = 20 existing model-typeset renders (free, already on disk).
B = coherent text-free plate + locally composited type at fixed safe-box placement.
C = B with placement from a vision-model spec per plate.

**FIRST ATTEMPT WAS INVALID — do not trust `samples13/` or `armB/`.** The text-free block was
SPLICED into a `social_proof_led` prompt whose attention order still demanded *"the rating and how
many people gave it / the customer's own words / the CTA"*. Self-contradictory. **All 8 plates
fabricated proof claims** — invented ratings (4.8), invented counts (6,942 / 734 / 2,391 / 1,952 /
1,702) and invented testimonials, against real values of 4.6 and 318.

⚠️ **That is a finding worth keeping on its own: a CONTRADICTION anywhere in the prompt can flip
the model into inventing social proof, with no bad data involved.** The `absences` rules hold when
the prompt is coherent and fail when it is not. Second contamination-by-splicing of the session
(the first was the "Triple-strap" description) — **use the genuine code path, never surgery.**

**Corrected runs, in flight at compaction:** empty `data` on `meta_stories_9_16` (the one surface
with `drawCta:false`), which makes goal, emphasis and absences all adapt together — verified
coherent, and the harness now ABORTS if the prompt still demands rating/quote/CTA.
`samples14/` = 1.5+high at `1024x1536` (its enum has no 1152x2048); `samples15/` = gpt-image-2 at
native `1152x2048`. 8 plates each, ~$0.84.

**Judge on:** do the plates come back genuinely text-free? does either model fabricate proof from
a COHERENT prompt? Then composite (`<scratchpad>/composite.js`, safe box must be re-set for
Stories: box top 17.5% / bottom 82.5%, not the square 6/94).

**TWO QUESTIONS FOR THE OWNER, both still unanswered:**
1. Reserve **just the rating** (where essentially all measured defects live — quote and CTA were
   correct in 12/12 even on 1.5) or the whole copy block?
2. The 2026-07-31 retirement of "direct image + exact overlay" — *"nobody liked the output"* — was
   that the **placement** or the **typography**? If typography, local compositing inherits the
   problem no matter what chooses the position, and arm C is not worth building.

**Harness/scratchpad map** (`/private/tmp/claude-502/-Volumes-Sayulita-Projects-RS/57cf15d6-ebb6-4803-bc54-5afba3628073/scratchpad/`):
`render-samples5..15.js` one per cell · `recover.js` re-polls any billed prediction whose image is
missing (never abandon billed work — poll loops with no deadline, ids ledgered to
`<out>/predictions.jsonl` before polling) · `sheet.js` / `audit.js` contact sheets ·
`BRIEF-typesetting-split.md` the test brief · seeds `ref.jpg` shoe, `ref2.jpg` Gymshark Flutter,
`ref3.jpg` PELAGIC Torrent, `ref4.jpg` Gymshark Campus Crest.

Measured prices: `gpt-image-2/edit` **$0.07593**, `-developer` **$0.03586**, `gpt-image-1.5/edit`
**$0.0289**. Session spend to date ≈ **$17.75**.

### 0.0f SHIPPING STATE + THE MEASURED GRID (2026-08-03). READ THIS BEFORE RE-RUNNING ANYTHING.

**SHIPPING STATE: the pre-compression prompt plus ONE sentence.** `WHO WEARS OR HOLDS IT` now
contains *"Keep the same person — do not replace them with someone else."* replacing the old
permissive *"You may change who that person is"*. The 2026-08-03 compression, the five-attribute
identity list, the closure/zip bans, the added-pocket ban and the logo-restyle ban are all
**REVERTED** — they measured worse. Prompt is 11.8k chars. `gpt-image-2/edit` remains the model.

**SIX 12-RENDER CELLS, ONE SEED (Pelagic Torrent, on-model). Do not re-derive these.**

`openai/gpt-image-2/edit` — text-safe, product-drifty:

| prompt | identity rule | model swaps | text defects |
|---|---|---|---|
| long 11.7k | permissive | 5/12 | 0/12 |
| compressed 9.6k | none | 5/12 | 0/12 |
| compressed 9.6k | 5-attribute list + closure bans | 7/12 | 0/12 |
| **long 11.9k (shipping)** | **one simple sentence** | **2/12** | **0/12** |

`openai/gpt-image-1.5/edit` + `input_fidelity: high` — product-perfect, text-broken:

| prompt | identity rule | model swaps | rating defects |
|---|---|---|---|
| compressed 9.6k | 5-attribute | **0/12** | 3/12, incl. a FABRICATED count ("438 reviews" for 318) |
| long 11.9k | simple sentence | **0/12** | ~11/12, incl. a WRONG VALUE (`4.4` for 4.6) |

**FOUR CONCLUSIONS, and three of them contradict what a reasonable person would guess:**

1. **Prompt LENGTH does not drive model swapping.** With the identity rule absent from both cells,
   long = 5/12 and compressed = 5/12. Identical. The compression was neither the problem nor a fix.
2. **A SIMPLE identity sentence beats an elaborate one, 2/12 vs 7/12.** Five named attributes plus
   three specific bans did *worse* than one sentence. Dilution operates at the clause level, not
   just at prompt scale. **Do not "strengthen" this sentence by adding detail — that was tried and
   measured worse.**
3. **Naming closures/zips in a preservation list did not help and plausibly hurt** (5/12 → 7/12
   when added, confounded with the identity list). Classic negation priming. Note the exposed zip
   ALSO appeared before that language existed, so the language did not introduce the defect — but
   nothing about it earned its place.
4. **Model swap is the mechanism for garment drift, in every cell.** Renders that keep the seed's
   person are faithful; renders that swap the person gain exposed closures, restyled badges and
   shifted colour together. Owner's read, confirmed: *"the only ones the shirts changed colors are
   the images where the person was removed."*

**`input_fidelity` IS THE REAL FIDELITY LEVER, AND IT IS BLOCKED ON TEXT.** `gpt-image-1.5/edit`
exposes `input_fidelity` (enum low|high, **default high**), documented by Atlas as preserving
"elements like faces or logos". It gave **0/12 swaps in both cells** — absolute product fidelity —
and is **62% cheaper** ($0.0289 vs $0.07593 measured). `gpt-image-2/edit` has no such parameter.
It cannot ship while the model typesets the rating: it invents star rows, and twice produced a
false number (a fabricated review count, and 4.4 for 4.6). A wrong rating is a false proof claim,
which is what `quoteProvenance` exists to prevent. **1.5 + high becomes the obvious choice the
moment the rating stops being model-rendered** — which cuts against the 2026-07-31 removal of SVG
overlay compositing, so it is a pipeline decision, not a prompt one.

**Across ~170 renders on four seeds, no fidelity WORDING has ever beaten the legacy prompt.** The
only measured wins are the person rule (product-only renders 3/6 → 0/12) and this identity sentence
(swaps 5/12 → 2/12). Everything else is unproven. CLAUDE.md §2's standing note — the fix is
measure-and-reject, not prompt tuning — has held up all day.

### 0.0e HOLD THE WEARER, AND CUT THE PROMPT DOWN (owner, 2026-08-03)

Two owner instructions, and they fit together — pinning the wearer let several hedges be deleted.

**1. The person is now held, not just required.** `THE PERSON` says the same person appears,
*keeping their face, hair, skin tone, build and identity*; they may not be replaced, removed, or
swapped for a hanger/mannequin/flat lay. Pose, expression, hands and framing stay free.

**WHY — measured, and it is a PRODUCT rule not a casting rule.** On the Pelagic Torrent seed,
every faithful render kept the seed's model and every drifting render had swapped him:

| | garment drift |
|---|---|
| same model as the seed (7 renders) | **0** |
| model replaced (5 renders) | **5** |

Verified at matched zoom: the swapped-model renders gained an **exposed black centre zip** where
the seed hides it under a storm flap, replaced the small rectangular badge with a plain `PELAGIC`
wordmark or an enlarged patch, and shifted the grey darker. Mechanism: preserving the person makes
this a local edit around a kept subject; replacing them makes it a full subject regeneration, and
the garment is then drawn from the model's prior instead of the reference. Same signature on the
Gymshark Campus Crest seed — its one on-model wrong-shirt render also had a swapped face.

Two specific bans were added from that evidence: **a closure the reference hides under a flap
stays hidden**, and **a pocket the reference does not show is never added**. Plus the graphics rule
now says a mark may never be *resized, restyled or swapped for a different mark*.

**2. The prompt is SHORTER despite gaining rules.** 11,732 → **9,619 chars**; `PRODUCT_FIDELITY`
itself 7.5k → **5.4k**. Cut: the product-category list (the "don't infer from category" rule does
not need one), the standalone NEVER paragraph (folded to one line), duplicated enumerations across
materials/details, and the ceremonial section formatting. Every enforceable rule survived — the
harness grew from 711 to **831 checks** while the text shrank, which is the point. `ADVERTISING
QUALITY` is now `MAKE IT GOOD`. Also added: *do not infer the product from its category, **its
name**, or anything you know about the brand* — aimed squarely at the Campus Crest failure, where
the model appears to render the catalog TITLE rather than the reference.

Still byte-identical on flag-off. Harness revert-proven on five mutations: deleting the identity
ban, vaguing the identity attributes, dropping the wearer from the not-free list, weakening the
added-pocket ban, and deleting the logo-restyle ban. All five fail.

### 0.0d THE PERSON RULE — the one prompt change with a MEASURED win (2026-08-03)

Owner instruction, after live renders on real catalog products: **remove the clause letting the
model decide whether a person appears.** `staticAdIntents.js` line ~721 read
*"YOU DECIDE EVERYTHING ELSE: composition and crop, camera angle and distance, **whether a person
appears**, lighting and mood…"* — that clause predates all of this work and it is why a PELAGIC
jacket seeded from an ON-MODEL photo came back as a jacket lying on a deck.

**Replacement is asymmetric** (`WHO WEARS OR HOLDS IT`, inside `PRODUCT_FIDELITY`): if the
reference shows the item worn/held, a person must wear or hold it the same way — who they are,
their pose, hands and framing stay free, but they cannot be removed and the garment cannot be
moved to a hanger, mannequin, surface or flat lay. If the reference shows the item alone, adding
a person is discretionary. **No plumbing needed for that conditional** — `buildPrompt` never
learns whether the seed has a person, but the MODEL can see the reference and evaluates it
itself.

**MEASURED, Pelagic Torrent seed, 12 hardened renders:**

| | product-only renders | colour drift |
|---|---|---|
| legacy prompt | 3 of 6 | 1 of 6 |
| hardened, no person rule | 2 of 6 | 2 of 6 |
| **hardened + person rule** | **0 of 12** | **0 of 12** |

**Why this matters more than the wording.** The causal chain runs through a rule I added:
`PRODUCT SCALE AND FRAMING` asks for the same share of frame as the reference, a person competes
for that area, so dropping the person is the cheapest way to comply — and an unpeopled render is
where the product drifts. On the Gymshark Campus Crest seed the hardened arm invented a whole
different product (dark brown tee with a large `GYMSHARK` varsity crest, laurel wreath,
`EST. 2012`) in **5 of 11** renders against legacy's **2 of 12** — and **4 of those 5 were the
product-only shots**. Owner's read, confirmed by the data: *"the only ones the shirts changed
colors are the images where the person was removed."*

So: the framing rule opened a hole and the person rule closes it. Do not remove one without
re-testing the other.

**STILL OPEN — the Campus Crest case is the first reproducible fidelity failure found, and the
hardening made it WORSE (45% vs 17%).** Prime suspect is the `PRODUCT:` description, which in
production is the real catalog title: *"Gymshark Campus Crest T-Shirt, brown"*. The model appears
to render the NAME — a campus crest, in brown — over the reference, which is exactly what the
block's "do not infer the product from its category… the reference is correct and your prior is
wrong" clause is supposed to prevent. A plausible aggravator is the block's long enumeration of
graphic types ("logos, branding, icons, artwork, patterns, prints, typography…") priming graphic
output. **Re-measure with the person rule on before drawing conclusions** — the Pelagic re-run
suggests much of the 45% may have travelled through the product-only path that is now closed.

Pinned by `scripts/verifyStaticFidelityPrompt.js` — 711 checks, revert-proven on three mutations
(restore the permissive clause, delete the no-flat-lay rule, invert the gate).

### 0.0c RENDER SAMPLES — run 1 VOID, run 2 in flight

**Run 1 (40 renders, non-dev model, $2.87) is VOID for product fidelity.** The `PRODUCT:`
description said *"Triple-strap"* — a miscount, the seed has **two** straps — and it went
into **both** arms, so every render was told three while shown two. Both arms produced a mix
of 2 and 3. Do not cite run 1 for strap/product fidelity.

**What run 1 DID establish, and it is the important part:** no copy regression. All 38
renders in both arms produced the rating, quote, attribution and CTA — so doubling the
prompt above `SET EXACTLY THESE STRINGS` did not break text fidelity, which was the whole
risk of this change. The `UNIFORM·SHOE` insole label also survived in both arms, confirming
the carve-out works.

**Run 2** re-runs on the developer model with a description that is accurate AND deliberately
**silent on strap count**, so the reference image is the only source for that attribute —
which is precisely what `PRODUCT_FIDELITY` claims to enforce. Harness:
`<scratchpad>/render-samples2.js` (not repo code; it re-polls Atlas for real prices).

⚠️ **ANOTHER SESSION WAS EDITING THIS SAME WORKING TREE CONCURRENTLY.** Mid-task the tree held
uncommitted `services/ratingDisplay.js` (+431) + `scripts/verifyCoherentSocialProof.js`; those
landed as **`9b61b02`** ("Tier-coherent social proof") while this work was in progress, and
`remotion/compositions/Canonical.jsx` + `services/adRegenerateService.js` then appeared dirty
from that same session. **None of it is part of this work and none of it was touched.** The
fidelity changes were re-verified against the moved HEAD afterwards (46/46 suite, 419-check
harness, byte-identical revert all still hold). If two agents share this checkout again, expect
`git status` to include work that is not yours — check `git log` before assuming a dirty file is
your own.

---

