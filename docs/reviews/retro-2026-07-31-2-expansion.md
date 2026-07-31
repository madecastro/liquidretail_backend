I'll adversarial-review the merged fan-out and Director universe changes against the seven hunt questions, reading the live paths rather than trusting the diff comments.Checking one more interaction: whether `MAX_ADS` applies after merge, and whether the Director format is wrong for fanned surfaces.## Adversarial review — static fan-out + Director universe

### 1. Money / duplicate `(concept, format)`

**no findings** for duplicate pairs from `formatsForKind`.

- `staticFanoutForPlatformFormat` returns either a unique 3-set, `[platformFormat]`, or `[]` — no duplicates.
- Video branch is always `[platformFormat]` (singleton).
- Cap buckets by `` `${kind}|${platformFormat}` ``; with fan-out on, 3 concepts × 3 sizes keep 9 image payloads at cap=3 (verified offline by `scripts/verifyStaticFanout.js`).

---

**HIGH** | `services/campaignAdsGenerationService.js:2365` (and missing cap before it; contrast `:785`) | Multi-product “All static formats” runs can queue **unbounded** image Ads past `MAX_ADS_PER_GENERATION_RUN` (default 200). | Concept path `insertMany`s post-bucket payloads with **no** global backstop. Legacy cartesian still has the backstop at `:785`. Fan-out multiplies image volume ×3 (`min(3,cap) × 3` per product). 23 products × 9 images ≈ 207 Ads, all billable on submit, with no trim. Amplifies known GEN-5; this change makes the image side hit it ~3× sooner.

---

### 2. Default-off byte-identical?

**MEDIUM** | `services/campaignAdsGenerationService.js:2126-2135` | With `expandStaticFormats` false/absent, **payload fan-out and cap shape match prior** (one format, one `kind|format` bucket), but the **universe is not byte-identical** for every caller. | Universe topN change is **not** gated on `expandStaticFormats`.  
- No picks: `topN: 10` → `DIRECTOR_UNIVERSE_TOP_N` (default 10) — same under default env.  
- Operator picks **≤10**: same.  
- Operator picks **>10**: previously truncated to 10; now `Math.max(mediaIds.length, DIRECTOR_UNIVERSE_TOP_N)` keeps all. Different Director input → different multi-ref stacks (still one image submit per Ad, not more Ads).  
Commit claim of exact prior behaviour for every existing caller is false for that case.

Fan-out itself with flag false: `staticFormats=[]` → `formatsForKind=[platformFormat]` — **no findings** for extra formats / extra bills.

---

### 3. `identityDigest` collapse across the 3 sizes

**no findings.**

`computeV2IdentityDigest` includes `platformFormat: fmt` and `kind` (`:1534-1545`, emission at `:2267-2272`). Simulated digests for the three Meta static keys are distinct; unique index will not swallow sibling sizes of the same concept.

---

### 4. Dry-run estimate vs real post-cap

Happy path with Director returning 3 concepts and default caps:

| expand | platformFormat | estimate | real (3 concepts, cap=3) |
|---|---|---|---|
| false | any image format | 3 | 3 |
| true | Meta static | 9 | 9 |
| true | `pmax_16_9` | 3 | 3 |

**MEDIUM** | `services/campaignAdsGenerationService.js:514-543` | Dry-run **over-quotes** whenever real concepts &lt; `min(3, ADS_PER_PRODUCT_CAP)` or products hit `empty_universe` / skipped concepts. | Formula assumes full concept fill × fan-out; never runs universe filter or Director. Pre-existing class of error; with expand on the absolute overstatement is ×3 (e.g. 1 concept survives → estimate 9, real 3).  
Hardcoded `Math.min(3, …)` is not tied to `N_CONCEPTS_ROUND` in `aiCreativeDirectorService.js` (currently also 3) — **low** drift risk if either side changes alone.

**no findings** for expand×format×cap under the normal Director contract (exactly 3 concepts, schema `maxItems: 3`).

`Math.max(1, fanout.length)` is harmless today: empty fan-out only for Reels/unknown, and those never set `conceptImage`.

---

### 5. Video fan-out / video cap

**no findings.**

- `kind === 'video'` → `formatsForKind = [platformFormat]` only (`:2226-2228`).
- Cap still `VEO_ADS_PER_PRODUCT_CAP` (default 1) on `video|<format>` bucket.
- Dry-run video line still `+= VEO_ADS_PER_PRODUCT_CAP` with no fan-out multiplier (`:529-531`).
- Deterministic video path is untouched by `expandStaticFormats`.

---

### 6. Universe change → silent `empty_universe`

**no findings** for topN itself emptying a pool that previously had candidates.

Widening topN (default 10, or larger with picks) can only keep more entries after rank. `empty_universe` still comes from empty pool / product-scoped operator picks / `excludePairings` wiping the truncated list — same failure modes as before, not introduced by a larger topN.

---

### 7. `excludePairings` reaching the renderer

**no findings** on the concept path under review.

Order is: build universe → `filterUniverseForProduct` → Director → primary/`mediaIds` must be in filtered `universeById` (`:2098-2101`, `:2193-2202`). Excluded IDs never land on `Ad.mediaId` / `Ad.mediaIds`. `renderService` fallback to `Ad.mediaIds` therefore cannot reintroduce them for this path.

---

### Other concrete defects in area

**MEDIUM** | `services/campaignAdsGenerationService.js:478-480` + conceptImage gate at `:449` | `expandStaticFormats=true` is a **silent no-op** when `conceptImage` is false (e.g. `AI_CONCEPT_DRIVEN=false` and image-only). | Flag is only applied inside the concept branch. Legacy cartesian never multiplies formats. Operator can opt into “all static formats” and get one surface with no error. Dormant while `AI_CONCEPT_DRIVEN=true` (current `defaults.env`).

**LOW** | `services/platformFormats.js:63-67,84-86` | `companions: [...]` still documents free centre-crops of a 9:16 master. | No consumer in repo (only declarations + the new “do not optimise back” comment). Risk is future “free crop” revival against model-typeset copy — documentation trap, not a live double-bill today.

**speculative / medium** | `services/campaignAdsGenerationService.js:2148-2150` vs fan-out loop `:2229-2277` | Director runs once with the **operator’s** `platformFormat` brief; fanned Stories/4:5 Ads reuse those concepts with different safe boxes. | Geometry at render uses per-Ad `fmt` (`staticAdIntents`). Copy/strategy may still be feed-shaped on Stories. Creative quality, not a double-submit.

---

### Summary table (hunt checklist)

| # | Result |
|---|---|
| 1 Money / dup pairs | **no findings** on dups; **HIGH** unbounded concept-path volume × fan-out |
| 2 Default-off identical | Fan-out: yes. Universe for picks &gt;10: **no** (MEDIUM) |
| 3 Digests | **no findings** — three distinct digests |
| 4 Dry-run | Happy path match; over-quote on skips/partial concepts (MEDIUM under expand) |
| 5 Video | **no findings** |
| 6 Empty universe | **no findings** from topN change |
| 7 excludePairings | **no findings** on concept path |
