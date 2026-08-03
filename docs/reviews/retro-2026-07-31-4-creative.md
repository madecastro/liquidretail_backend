I'll run a creative-quality adversarial review against the live pipeline files you listed, focusing on fabrication, data fidelity, safe zones, and intent degradation.Session notes lag the live path — code shows gpt-image-2 typesetting copy. Digging into data mapping, quote sources, and safe-zone geometry next.Next I'll trace how `layoutInput.social_proof` is built and whether Sharp crop geometry can disagree with the prompt.Layout-input quote tiers and crop geometry look like the highest-risk paths — reading those next.Checking one more fabrication path: whether synthesized/LLM quotes are filtered before the intent mapper, and how category quotes are scoped.# Creative-quality adversarial review

Scope: live path **Director → `staticAdIntents.buildPrompt` → gpt-image-2/edit → Sharp crop + logo composite**. Focus is wrong / misleading / low-quality creative, not money or refactors.

---

## 1. FABRICATION

### BLOCKER | `layoutInputService.js:1889-1941` → `directImageRenderService.js:240-247` | Invented customer quote ships as proof
Quote pool tiers **5–6** are not real reviews:
- Tier 5: `derivation.quotes` — LLM “notional” persona quotes (`:1179-1182` literally asks the LLM for notional reviews)
- Tier 6: `synthesizeQuoteFromReviewSummary` — first sentence of an LLM review **summary**, stamped `origin: 'synthesized'`, `verbatim: false` (`:1676-1691`)

`buildIntentData` maps `primary_quote.snippet || .text` with **no `origin` / `verbatim` check**. Those strings enter the text block as:

```
customer quote -> "…"
```

and are typeset into pixels as a customer testimonial.  
Owner rule: *NEVER invent proof*. This is the same class of failure as v1 empty-slot fabrication, via the **data layer** rather than the prompt.

### BLOCKER | `layoutInputService.js:1548-1550` + `directImageRenderService.js:251` | Attribution invents identity
`normalizeQuote` sets:
```js
author_name: q.author_name || q.author || q.source ||
             (verified ? 'Verified buyer' : 'Anonymous Customer')
```
So the ad can show:
- **`— Verified buyer`** when there is no name (owner rule: *"Anonymous Customer" only when there is no name*)
- **`— <source>`** when `source` is a string (e.g. platform label) used as a person byline

That is fabricated or mislabelled attribution, not a real reviewer name.

### HIGH | `staticAdIntents.js:273` + rating-only text | Goal asserts scale the data may not support
`social_proof_led.goal` is fixed:
> *“many real people already bought this and rate it highly”*

Eligible with **only** `d.rating`. A product with `4.8 ★` and **3 reviews** still gets that goal, plus the string `4.8 ★ (3 reviews)`.  
Absence list correctly bans inventing a quote, but the **goal itself** is a soft instruction to communicate mass adoption that the numbers may contradict. Model may not invent a quote (v1 defect is largely closed in the prompt), but it can still over-claim visually (crowds, “community” chrome). *Partly speculative on pixels; goal string is concrete.*

### HIGH | `aiCreativeDirectorService.js:1474` + `validateDirectorPayload:959-961` + `product_first` BRAND LINE | Fabricated proof via headline
Director is told to write final `copy_picks` and to prefer specific checkable claims (`OBJECTIVE_BLOCK` “Holds a charge six days”). Validator only blocks:
- product **name** (≥4 chars substring)
- price/discount regex (`$`, `% off`, `sale`, etc.)

It does **not** block invented scale, ratings, awards, or “10,000 women swear by this”.  
Those headlines become `BRAND LINE` in `product_first_lifestyle` and ship as typeset copy. That is proof-shaped claim fabrication outside the quote/rating fields.

### MEDIUM | `staticAdIntents.js:236-265` absences (v1 class) | **Mostly closed in the prompt**
Across the intent × data matrix (all-absent, rating-only, quote-only, full, stories/feed):
- Empty text → `"THIS AD CARRIES NO TEXT AT ALL"` (not an empty SET list)
- No quote → explicit ban including “never re-dress a tagline… as something a customer said”
- Rating present → star-row fence
- Stories → CTA absence with platform note
- Geometry is element-agnostic (no “put the CTA in…”)

**no findings** for the classic v1 “empty slot + make proof loudest → invented testimonial” **inside `buildPrompt`**, *provided* `data.quote` is honestly empty. The residual fabrication risk is **upstream data** (tiers 5–6) and **Director headlines**, not the absence block.

### MEDIUM | `staticAdIntents.js:323-329` | `objection_resolved` eligible on *any* quote
`eligible: (d) => d.quote ? null : '…'` does not require risk-reversal content. A generic “Love it!” quote still runs the intent whose goal is *“the specific worry… answered”*. Not invented proof, but **misleading intent packaging** of weak proof. *Quality / honesty of framing.*

---

## 2. TRUTHFULNESS OF MAPPED DATA

### BLOCKER | same as §1 tiers 5–6 | Quote field is not always a review
`buildIntentData` comment claims *“Every field here is READ, never derived”* (`:215-220`). That is true of the mapper, **false of the value it reads**. `primary_quote` can be synthesized / notional while looking like a first-party review.

### HIGH | `layoutInputService.js:1896-1897, 1927-1931` | Category-tier quote on a product ad
Tier 2 is *“same category on this brand”*, not this SKU. Winner becomes this product’s `CUSTOMER QUOTE`. Same cross-product class the brand-tier guard (`:1914-1918`) was written to stop — partially still open one tier up.

### HIGH | `directImageRenderService.js:240` + `quoteSnippetService.js:134-166` | Snippet is not always a full verbatim quote
Prefer `snippet` over `text`. Snippet can end with **`…`** from mechanical truncation. That string is then wrapped in quotation marks in the intent text block (`"${d.quote}"`). A marked excerpt presented as the customer’s full sentence is incomplete at best, and can change meaning if the rest of the sentence qualified the praise.

### MEDIUM | `aiCreativeDirectorService.js:440` vs `buildIntentData:243` | Rating formatting differs by stage
Director signal: `Number(ratingValue.toFixed(1))`.  
Static intent: `String(proof.rating_value)` with **no rounding**.  
A raw `4.85` or float noise ships as `"4.85 ★"` (or longer). Not invented, but not a single canonical “real number” presentation.

### MEDIUM | `buildIntentData:243` + `staticAdIntents.js:277` | Rating `0` is truthy as string `"0"`
`rating_value: 0` → `"0"` → social_proof eligible → `"0 ★"`. Degenerate but real if bad data lands.

### LOW | `buildIntentData:254-256` | `badge` hard-coded `undefined`
Derived badges (`Top rated`, `1k+ reviews` at `defaultBadgesFromSignal:1697-1705`) never reach the image path. **Good for anti-fabrication** (those badges are derived claims). **no findings** on inventing badges via this mapper — badges cannot ship here at all.

### LOW | Director product-scope guard | **Survives for Director signals**
Brand quotes withheld when `isProductScoped` (`aiCreativeDirectorService.js:402-408`). Layout still has category/synth paths above.

### no findings | primary product rating/count when present
When `rating_value` / `review_count` are real numbers from layout, mapper does not default a fake rating or invent a count (`review_count > 0` required).

---

## 3. TEXT FIDELITY

### HIGH | Whole path: model typesets; no post-render string check | Misspelling / reword ships
Prompt says “SET EXACTLY THESE STRINGS, verbatim” and “Spelling is critical” (`staticAdIntents.js:415-418`). There is **no OCR / string-equality gate** after edit. Prior measurement (header comment) is not an online guard. Any re-word, synonym, or typo becomes the ad.

### HIGH | `staticAdIntents.js:423,435` latitude language | Soft invitation to “campaign” craft
> *“build an entirely new scene”*  
> *“make it look like a campaign a good agency shipped”*  
> *“Inventiveness belongs in the photography, the light and the typography — never in the claims.”*

Typography inventiveness + agency language historically pulls models toward “better” wording. Claims are fenced; **copy drift still happens in practice** (measured history in file header). Residual risk, not a missing fence.

### MEDIUM | `staticAdIntents.js:414-417` role labels | **Mostly closed**
Role is lowercase left of `->`, with explicit “must NEVER appear”. Known defect was `RATING: 4.8 ★` with label printed. Current form is the fix. Residual risk is model non-compliance only (*speculative*).

### MEDIUM | `staticAdIntents.js:418` vs `:423` | Product print conflict
Text block: *no letterforms … including on … clothing within the scene*.  
Product rule: *branding printed on the product itself stays*.  
Model may strip real packaging/print (product fidelity) or keep extra text (text fidelity). Contradictory instructions.

### MEDIUM | Director `copy_picks` are free composition
Headlines are LLM-authored, not extractive. By design they re-word brand voice. Only product name / price are blocked. Expected for brand lines; dangerous when they smuggle proof (see §1).

### LOW | `buildIntentData:256` | Default CTA `'SHOP NOW'`
If layout CTA missing, default is not from Director `copy_picks.cta` (which is ignored). Not a misspelling issue; fidelity to Director intent fails.

---

## 4. SAFE ZONES / CROP

### BLOCKER | `directImageRenderService.js:486-488` vs `staticAdIntents.js:99-103,145-162` | Crop math the prompt teaches is not the crop Sharp runs
Geometry assumes **symmetric centre crop** of gen → delivery aspect (`cropLeftPx = cropW/2`, etc.).  
Sharp does:
```js
.resize(dims.width, dims.height, { fit: 'cover', position: 'attention' })
```
`attention` is **content-aware and asymmetric**. Copy placed in the prompt’s “surviving” box can still be sliced; copy the model thought was dead can survive. **Destroys the geometric guarantee** of the safe box. Concrete, not speculative.

### BLOCKER | `directImageRenderService.js:501-502` + Stories/Reels reserves | Logo composited into platform UI band
Logo always:
```js
top: dims.height - 100, left: dims.width - 224  // ~56px tall
```
On `9:16` canvas `1000×1778`:
- logo occupies ~y **1678–1734**
- Stories reserve starts at y **1528** (bottom 250)
- Reels reserve starts at y **1574** (bottom 204)

**Logo is fully inside the reserved band** on Stories/Reels static. On Stories, `drawCta: false` already avoids CTA-in-reserve; logo does not. Ships a brand mark under the reply / reaction chrome.

### HIGH | Prompt box vs Remotion `SAFE_ZONES.vertical` | Video vs static disagreement (and Stories/Reels collapse on video)
| System | Stories vs Reels | Bottom reserve |
|---|---|---|
| `platformFormats` static | 250 vs 204 (distinct) | ~14% vs ~11.5% of canvas |
| `staticAdIntents` | per-surface boxes (good) | Stories top/bot ~14.1%; Reels ~11.5% |
| `remotion/lib/safeZones.js` `vertical` | **one** class for Reels **and** Stories | **bottom 35%**, top 14% |

So:
1. **Static path per-surface boxes are basically correct** relative to `platformFormats` (plus 6% edge margin). Stories is tighter than Reels as intended.
2. **Video titling collapses Stories and Reels** and uses a **much deeper bottom (35%)** than platform UI (~11–14%). That is safer against chrome but **wastes ~20% of the frame** and is not the same quality contract as static. Real quality defect for consistency of “safe” meaning across media types; less often “copy under chrome” on video, more “arbitrarily cramped vertical type”.

### HIGH | Known schema gap | `staticAdIntents.js:48-52`
`safeArea` has no left/right. Horizontal IG UI is unmodelled. Crop-only horizontal inset on 9:16 (80px each side of 1024). Speculative how often Meta side chrome bites; **documented gap**.

### MEDIUM | `dimsFor` vs `deliveryDims` | `directImageRenderService.js:98-104` vs `platformFormats`
Render buffer is **1000-wide** (canvas), while formats declare delivery **1080 / 1920**. Geometry text says “delivered at 1080x1920” but Sharp emits 1000×1778. If a later CDN upscale is assumed, OK; if anything treats buffer as final delivery pixels, safe math and logo placement are in the wrong coordinate space. *Depends on upload path — flag as medium.*

### MEDIUM | Stories with no text | Hollow full-bleed OK by design
Empty text + platform CTA + logo-in-reserve: ad can be **product photo only**, with logo hidden under UI. Intent “recognise the brand” fails.

### no findings | Static Stories/Reels **prompt** differentiation
`computeSurface` correctly maps 250 vs 204 into gen-space reserves. Static **prompt** treatment is not identical for Reels vs Stories. (Reels static is skipped entirely via `static: false`.)

---

## 5. PRODUCT FIDELITY

### HIGH | `staticAdIntents.js:423` | Scene rewrite is mandatory
> *“Reproduce this exact item faithfully … then build an entirely new scene around it. Do not reuse the reference's background, crop or lighting.”*

Colour/material/construction are protected in prose; models still recolour, reshape, or “premiumize” products under lifestyle pressure. Residual, *partly speculative*, but the instruction **forbids** using the real photo’s crop/lighting, which removes the strongest fidelity anchor.

### HIGH | Multi-ref collage | `directImageRenderService.js:375-408` + Director multi-picks
All resolved `mediaIds` go as edit references. If the universe contains **sibling SKUs**, UGC of a different colourway, or a lifestyle shot of another product, the model is asked to compose them. Product-mismatch of **concept artifact** is blocked (`:272-276`); **wrong media inside the same product’s universe** is not. *Severity depends on seeding quality.*

### MEDIUM | Fallback ref | `:393-397`
If picks fail: seed media, else **catalog `imageUrl`**. Can be a packshot of a different colour or a lifestyle pack image. Better than inventing a product (zero-ref correctly throws).

### MEDIUM | Model-drawn logo banned; composite can fail silently | `:498-503`
Prompt forbids drawn logos; if `logoUrl` fetch/compose fails, log + **no logo**. Corner may stay empty (wasted) or model may still sneak a wordmark (*speculative*). Owner exception is implemented correctly when logo bytes exist.

### LOW | `describeProductForPrompt:140-146` can pass `product.title`
Briefing can include the product name; absence says no product name in the image. Name is not in the SET list. Usually OK; risk if model echoes PRODUCT line into type.

### no findings | Zero-reference invent-product path
Hard fail before billable submit (`:421-426`). Good.

---

## 6. INTENT DEGRADATION

### HIGH | `intentForTemplate` + `CREATIVE_STYLE_TO_TEMPLATE` | Style → intent is lossy
| `creative_style` | template | intent |
|---|---|---|
| `social_proof_led` | `ai_social_proof_led` | `social_proof_led` |
| `promotional` | `ai_promotional` | `objection_resolved` |
| `brand_led` / `ugc_led` / `editorial` / default | `ai_*` | **`product_first_lifestyle` always** |

So a Director concept with a strong quote + `ugc_led` **never shows the quote** (product_first text has no quote role). Quote-only data under default intent → CTA-only (or zero text on Stories). **Silent drop of the element that made the concept worth running.**

### HIGH | `social_proof_led` ignores `copy_picks.headline`
Even when Director wrote a conversion headline, social_proof text is only rating / quote / attribution / badge / CTA. Headline discarded. Not hollow, but **Director copy and shipped copy diverge**.

### MEDIUM | Hierarchy fallback is not hollow for core proof
- no rating on social_proof → walk to objection (if quote) or product_first  
- no quote on objection → social_proof (if rating) or product_first  
- product_first always eligible  

**no findings** for “social_proof_led with no rating still runs as social_proof”. Fallback works.

### MEDIUM | Density sacrifice | `applyDensity` + Stories `maxTextElements: 3`
On full social_proof Stories: BADGE dropped first; RATING+QUOTE+ATTRIBUTION kept. Core RATING never sacrificed.  
On feed budget 4: BADGE dropped; quote kept.  
**no findings** for sacrificing `CUSTOMER QUOTE` while leaving an empty proof intent when quote is core (`objection_resolved` core protects it).

### MEDIUM | product_first + rating only as “TRUST MARK”
Intent goal is lifestyle/brand, not proof; rating is secondary. OK.  
product_first + **no** headline + **no** rating + Feed = **only `SHOP NOW`**. Hollow relative to “want the life the product implies” — CTA-sticker on a photo.

### LOW | `badge: undefined` always
Badge never ships on this path; density “BADGE” sacrifice is mostly dead code for direct image.

---

## 7. CONSISTENCY ACROSS SIZES

### HIGH | Three independent billable generations | `platformFormats.js:168-177` + fanout
Same concept → `meta_feed_1_1` + `meta_feed_4_5` + `meta_stories_9_16`, each with its own edit call and prompt geometry. No shared layout seed. An advertiser can get:
- different type hierarchy / panel treatment  
- different misspellings of the same string  
- Stories with no CTA vs Feed with CTA (by policy — correct)  
- Stories logo under chrome vs Feed logo visible  

Owner accepted separate generations for typeset-in-pixels; **consistency is not enforced**. Real “broken campaign set” risk.

### MEDIUM | Intent can differ by surface only via density/CTA, not data
Same `intentData` everywhere; good. Stories drops CTA; density may drop BADGE. Acceptable product policy, but the three assets are not “same ad, different crop”.

### MEDIUM | Director runs once per product, not per surface | `campaignAdsGenerationService.js:2216-2222`
Copy is shared; only geometry differs. Good for message consistency; bad if headline length is wrong for Stories density (model must reflow; may drop or crowd). *Speculative on failure mode.*

### no findings | Concept–product mismatch guard
Artifact `productId` must match ad product (`directImageRenderService.js:272-276`). Prevents the documented “Strength, in pink” / wrong SKU copy bug.

---

## Cross-cutting: owner hard rules checklist

| Rule | Status |
|---|---|
| No price / currency / discount / offer | Prompt absence + Director validator on copy_picks. **Residual:** layout `offer_text`, trusted_by, free-text headlines without `$`. |
| No product NAME in ad copy | Director forbiddenStrings + absence line. **Residual:** PRODUCT briefing title; name &lt; 4 chars not checked. |
| Never invent proof | **FAIL** via synth/LLM/category quotes + free headlines with scale claims. Prompt absences good when data is empty. |
| Quotes verbatim from real reviews | **FAIL** if tier 5–6 win; snippet ellipsis; “near-verbatim” allowed in snippet LLM. |
| “Anonymous Customer” only when no name | **FAIL** — `Verified buyer` / `source` used instead. |
| Rating real + only rating mark | Number from data when present; star-row fenced in prompt. **Residual:** model non-compliance; rating `0`; unrounded floats. |
| Stories/Reels no in-pixel CTA | Stories `drawCta: false` **yes**. Reels static **skipped**. Video storyboard can still place `cta` beats (*video path, out of static scope*). |

---

## Highest-priority fixes (creative correctness only)

1. **Refuse non-first-party quotes in `buildIntentData`** — drop if `origin ∈ {synthesized, llm-web}` or `verbatim === false`; do not pass tier-5/6 into CUSTOMER QUOTE.  
2. **Attribution** — only real names; else exactly `Anonymous Customer` (never `Verified buyer` / source string).  
3. **Sharp crop** — `position: 'centre'` (or explicit crop matching `computeSurface`), never `attention`, while geometry is centre-based.  
4. **Logo placement** — sit logo inside the **text-safe box**, not fixed bottom-right into Stories/Reels UI reserve.  
5. **Category quotes** — do not use as product-ad primary without product-scope proof they refer to this SKU.  
6. **Director headlines** — block fabricated scale/rating/award patterns in `copy_picks`, or stop using free headlines as BRAND LINE without a claims gate.  
7. **Intent routing** — map proof-heavy concepts to intents that can surface quote/rating; don’t leave `ugc_led`/`editorial` as pure product_first when the concept’s whole point is a testimonial.

---

## Sections with genuine “survives” notes

- **v1 empty-slot fabrication inside `buildPrompt`**: largely fixed (absences + empty-text branch + element-agnostic geometry).  
- **Brand-tier quote on product ads (Director + layout brand tier)**: guarded.  
- **Zero product reference → invent product**: hard fail.  
- **Concept artifact from wrong product**: hard fail.  
- **Stories in-pixel CTA**: correctly suppressed.  
- **Badge derived “Top rated” on this path**: cannot ship (`badge: undefined`).  
- **Static per-surface safe boxes from `platformFormats`**: arithmetic is coherent; broken by Sharp `attention` and logo placement, not by the box math itself.

I did not run live renders; severity on model non-compliance (misspell, star row, recolour) is marked where it depends on the image model rather than deterministic code.
