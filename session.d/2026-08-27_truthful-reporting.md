# 2026-08-27 — Four diagnostics that reported something untrue

Branch `fix/truthful-reporting-be` (backend) + `fix/truthful-reporting-fe` (frontend).
Backend must land first — the SPA reads two new response fields and is written to render
unchanged without them.

All four defects were found by driving the real app. They share a theme: **each caused the
system to report something untrue to whoever was looking**, and one had been actively
distorting a live investigation.

---

## 1. The inspector contradicted the render path — and suppressed the warning that mattered

`GET /api/ads/:id/generation-inspector` reported `seedHasText: false, burnedInText: []` for
an ad on which `veoPromptBuilder.js`'s `if (seedHasText)` had **fired**.

**Root cause: a DECODE MISMATCH.** Not staleness, not a missing write, not an ordering
problem — all three of which were the hypotheses handed to me.

| | derivation |
|---|---|
| producer (render) | `Array.isArray(media.text) && media.text.length > 0` — a raw COUNT |
| reader (inspector) | mapped each element through `t?.text \|\| t?.value`, `filter(Boolean)`, then `.length > 0` of THAT |

The only production writer of `Media.text` is `subjectTextService.js:128-135`, whose elements
are `{ id, content, type, x1, y1, x2, y2, confidence }` — the readable string is on
**`content`**. So every element decoded to `null`, the decoded array emptied, and the boolean
inverted. Same document, same field, same instant. **Every other live reader in the repo
already used `.content`** (pipelines/detect, judgeService, adSuitabilityService:169,
layoutInputService, aiCanvasInputBuilder, aiCanvasHtmlGeneratorService, brandSafetyService);
the inspector was the sole outlier.

**Why it mattered more than a wrong boolean.** The `seed-has-burned-in-text` warning exists
specifically to tell an investigator that burned-in SOURCE text — *not* the titling engine —
is the usual cause of garbled on-screen text. Deriving the flag from the decoded array meant
the warning was silent on exactly the ads where the render had detected the condition. A
whole session was spent chasing garbled typography with this signal off.

**Fix** — `services/seedTextTruth.js`, imported by the route (never inlined, so the harness
can call the real function). Three signals, descending authority, and the source is reported:

1. `render-prompt` — the persisted `Ad.veoPrompt` carries the guard sentence. Strongest
   evidence: it describes the *submission*, and it survives `Media.text` being overwritten
   afterwards (each detect run `$set`s that array wholesale, including to `[]` when its
   subjects-text stage fails).
2. `seed-media` — the raw element count, mirroring the producer term for term.
3. `none`.

The boolean no longer depends on decodability at all: an element with an empty `content` still
counts, because the render path only counts. **Both directions of prompt-vs-record
disagreement now raise their own warning.**

`SEED_BURNED_IN_TEXT_GUARD_LINE` was hoisted out of `buildVeoPrompt`'s assembly and exported
so the inspector can detect it — **proven byte-identical to `origin/main` across 288 input
combinations**, so B14/B15 are untouched.

### Line references drifted, as warned

`veoPromptBuilder.js:1084` was **correct**. `routes/ads.js:4959` was **stale** — the block is
at **5056-5070** on `origin/main`. 4959 is a different handler region entirely. Both the
backend and frontend shared checkouts are dirty stale replays; local `main` is missing 412
lines of `routes/ads.js` that `origin/main` has, so any line number read from them is wrong.

---

## 2. The wizard's prompt preview — premise refuted, a real defect remains

**Refuted by execution.** "Two separate builders produce different text" is false:
`buildPromptScaffold` calls the canonical `buildVeoPrompt`, and a scaffold-argument call is
byte-identical to the builder's own output.

**Refuted by git.** "The `Product:` line is one a prior fix removed from the real builder
after it caused a model to fabricate a brand wordmark" — no. `git log -S` shows the line was
**added** by `5a7d954c` and is still at `veoPromptBuilder.js:788`, emitted by the same builder
both paths use. `/^Product: /` entered `DROP_PRIORITY` via `6b3ec8ac` (the Omni-default
commit) and `08862229` — *"keep Grok prompt under 4096-byte cap on verbose ads"*, a
deliberate byte-cap guard. No wordmark incident appears in any commit message.

**The real mechanism, measured.** At every one of the five registered model caps `Product:` is
PRESENT. It is dropped only when the assembled prompt exceeds `cap - 96`. The guard block is
**+283 bytes**, and the scaffold hardcodes `seedHasText: false` — so with a destination
profile at a 4096 cap:

| | bytes | `Product:` |
|---|---|---|
| preview (guard off) | 3,885 | present |
| real (guard on) | **4,168** | **dropped** |

4,168 is within **2 bytes** of the 4,170 measured on the real ad. Same builder, different
budget. **And 4,168 > 4,096** — after every droppable line is gone, so `enforceByteCap` logs
*"Atlas will reject"*. Flagged as a finding in its own right; pinned by B4d.

**Fix = label, not close.** The destination-less scaffold prompt is a documented frozen
invariant (`CLAUDE.md` §00, pinned by `verifyPostPilotBatch` B14 against the `9531ae9f`
baseline), so changing what the scaffold passes would break a deliberate rollback guarantee.
The endpoint now returns an `approximation` block naming every assumed input
(`seedHasText: false`, `hasProductReference: true`, `media: null`) and every omitted one
(`layoutInput`, `sourceMedia`, `storyboard`, `seedStyle`, `variantKind`), plus where the exact
submitted prompt lives. **Zero prompt bytes change.** The SPA renders it beside the editor.

One honest correction to my own first draft: I claimed those five omitted inputs each change
the prompt. Measured — with `media: null` and flags at default they produce **zero** byte
delta. They are omitted, but I could not prove they matter here, so the PR says so.

---

## 3. The stale creative brief — label its age, do NOT bind it

Confirm screen showed *"Goal: Drive purchases of the Merino Crewneck Sweater"* dated two days
earlier while the products list showed a different garment. No staleness indicator; the
Generate button sits directly below.

**Two prior deliberate decisions make auto-rebinding the wrong fix**, both verified verbatim:

- `b6ba434` shipped the panel as a **hand-editable** brief with an explicit Refresh, "so
  operators can sanity-check + adjust the intent that will feed the Director on THIS run".
  Silent re-derive on every product change would discard typed work (`derivedFrom:'manual'`)
  and fire a paid LLM re-derive on every picker tick.
- `5a82ad3` **names this exact hazard in its own message** — *"Same shape of mistake as the
  campaign creative brief being fed to every product's Director round: campaign-scoped data
  applied to a product-scoped job"* — then fixed the campaign **pins** and deliberately left
  the brief campaign-scoped. The scoping is known and accepted; what was missing was the
  operator being able to SEE it.

There is also **no field to bind against**: `CreativeBrief` carries no `productId` or
`productTitle`, so a precise mismatch check is unavailable. Age and scope are, and both were
already in hand — `briefDerivedAt` was fetched and rendered as a bare `toLocaleDateString()`,
which reads as provenance metadata, not a warning.

**Fix:** a `Campaign-wide` scope badge, a relative-age badge that turns orange at ≥1 day, and
a non-blocking orange callout (the same treatment Step 4 already uses for "Account setup
incomplete") when the brief is stale. Non-blocking on purpose — a two-day-old campaign brief
is often correct, and Refresh/Edit sit two inches above. The brief does **not** reach the
generate POST (`buildBody` is brief-free), but per `5a82ad3` it *is* fed to every product's
Director round via `campaignId`, so the risk to titles is real.

---

## 4. Failed ads counted as coverage

`/api/catalog/ads-summary` reported `coveragePct: 100, adCount: 12` for a product whose 12 ads
had **all failed** with zero assets — same response: `draftCount: 0, liveCount: 0,
readyToExport: 0`. Header advanced 18 → 30 "ADS CREATED" and "1 of 200" → "2 of 200
products".

`Ad.status` has six values; only `archived` was excluded, so `failed`, `queued` and `rendering`
all counted. **The two endpoints use DIFFERENT formulas** — catalog is an ad-count ratio
`min(100, round(adCount/TARGET × 100))`, campaigns is a product ratio
`productsWithAds/matchedProductIds.length` — but both were fed by the same status-blind `$sum: 1`,
so the conclusion holds for both while the arithmetic does not transfer.

**Measured on live production data.** Marine Layer product `6a8d47cfd9e1e0e1dccee389`: 12
non-archived rows, all `failed`, zero assets → `min(100, round(12/5 × 100)) = 100`. Re-checked
under the strict `isAdHonestlyDelivered` predicate: 0 of 12 holds there too, and no
paid-but-unchromed master is hiding (`veoVideoUrl: null`, `renderUrl: null`,
`titlingNeeded: false`, `titlingResumeState: null`), so the fix cannot be accused of turning a
nearly-delivered ad into a reported failure.

### ⚠️ The sort consequence — the functional half

`routes/catalog.js` sorts `lastActivityAt` DESC then `coveragePct` **ASC**, and the comment above
it says that tiebreak exists *"so products needing attention surface above well-covered ones."*
Scoring an all-failed product at 100 inverted exactly that signal. Executed over the real
comparator at equal recency:

| | trunk | fixed |
|---|---|---|
| 1st | untouched, 0% | **ALL-FAILED, 0%** |
| 2nd | half-covered, 40% | untouched, 0% |
| 3rd | **ALL-FAILED, 100%** | half-covered, 40% |

The worst-off product sorted **last** in the list built to surface products needing attention.

*Scope, stated precisely because the first framing of this overreached:* the burial is **within a
recency group**, not absolute. `models/Ad.js:735` gives `generatedAt` a `default: Date.now` and
`AD_RECENCY_EXPR` is `$ifNull[renderedAt, generatedAt]`, so a freshly-failed product has a recent
`lastActivityAt` and still sorts near the top on the primary key. The durable harm is that as the
failure ages it drifts down while still claiming 100% covered, so it never resurfaces.

**`failedCount` already existed on trunk** — computed in the same `$group` since `ed3e6d83`, never
projected. The honest number was computed server-side and discarded one line later.

**Checked for a prior deliberate decision before changing anything — there is none.** Coverage
shipped in `ed3e6d83` explicitly as a *"placeholder formula: adCount / 5, capped at 100"*; the
code comment still says Phase 2 replaces it; the only status rule ever written for it was
`$ne: 'archived'`; and that same commit **already computed `failedCount` and then never
returned it or subtracted it** — the distinction was drawn and left unused. When `9d632297`
(#278) later defined *delivered*, it named `failed` and non-terminal as never delivered and
applied that to ads-detail, the run rollup and Meta push — **but never to these two
aggregations.** This is an alignment with the repo's own definition, not a reversal.

**Fix:** one shared definition, `services/adDeliveryCounts.js`, imported by BOTH
`/ads-summary` endpoints (`routes/campaigns.js`'s own comment says it "mirrors" the catalog
one; the two silently disagreeing is how this stayed invisible on both).

Adversarial review then caught my first draft as **only the status half**: `draft|live` alone
still counts an untitled video draft (paid master landed, chrome never composited) as covered,
while `titled: isAdHonestlyDelivered(a)` — projected on ads-**detail** in the same two files —
says it is not delivered. Two definitions of delivered on one route. `deliveredExpr()` is now
a branch-for-branch aggregation mirror of `isVideoTitlingSettled`, **parity proven by running
both over 1,680 ad shapes through a real mongod**. `untitledDeliverableCount` reports that
population instead of hiding it.

**Deliberately NOT changed: `adCount` / `adsCreated`.** They count attempts, and "12 ads were
created" is true even when all 12 failed. The untruth was calling the product *covered*;
narrowing these too would swap one false statement for another. The outcome split is returned
alongside so a UI can say "12 created · 0 delivered · 12 failed".

**A fresh untruth my own fix would have introduced.** The SPA's `coverageLabel(0)` returned
**"No ads"** — so a product with 12 failed ads would have read "No ads", equally false in the
opposite direction, hiding the failures completely. Both copies (ProductAds, Campaigns) now
split the zero case by outcome: **"Nothing delivered"** (red), **"Generating"** (orange), or
"No ads".

Minor, same PR: `"12 creatives (12 standard video, ≤3 per product)"` was self-contradictory
because `formatPreviewBreakdown` appended the cap clause unconditionally. The cap is
per-(product, KIND): images `ADS_PER_PRODUCT_CAP` (3), Director video
`VEO_ADS_PER_PRODUCT_CAP` (1), and **deterministic video has none** — that file says outright
*"No VEO_ADS_PER_PRODUCT_CAP — always exactly one ad per product that has a resolvable seed,
per format call"*, and Meta mints 4 surfaces × 3 funnel stages = the 12 that made the line
contradict itself. Clause is now scoped to the images arm and names its unit.

---

## Verification

- `scripts/verifyTruthfulReporting.js` — **80/80** with mongod (56 offline + 24 group D).
  Behavioural: every check calls the real exported function or runs the real `$group`
  accumulators through a real mongod. Group D **skips loudly** without
  `TRUTHFUL_VERIFY_MONGODB_URI`.
- **21/21 mutations caught RED, 0 vacuous** (`scripts/mutateTruthfulReporting.sh`), tree
  byte-restored after each. M21 reverses the coveragePct tiebreak and must stay red.
- Guard-line hoist byte-identical to `origin/main` over 288 input combinations, with arm
  checks proving the sweep was not vacuous.
- Suite **208/211** after rebasing onto `b5a42717`, with the same three pre-existing failures
  as a freshly measured pristine trunk (`verifyDirectorFallbackChain`, `verifyPreparingReap`,
  `verifyRenderStages`). eslint clean, and the `no-undef` check was *proven* to exercise the
  edited region by injecting an unbound identifier and confirming it went red.
- SPA: `npm run type-check` and `npm run build` clean; the type-check was likewise proven to
  exercise the edited file. Both pure helpers (`briefAge`, `formatPreviewBreakdown`) executed
  headlessly against their real modules — 14/14.

## Two vacuous checks this harness caught in itself

Worth recording, because both would have shipped as green:

1. A sweep over 65 product-description lengths asserting the `Product:`-drop transition —
   **description never reaches the camera prompt**, so it tested nothing. Replaced with the
   destination/cap axis that actually moves it.
2. Mutation 19 ("`distinctOnDelivered` reverts to status-only") came back **GREEN**: the
   existing D4 only exercised draft-vs-failed, which a status-only predicate gets right.
   Fixed with D4c (an untitled video draft that must be excluded), then re-confirmed red.

## Not changed, deliberately

- The scaffold's prompt bytes — a frozen invariant (B14).
- `adCount` / `adsCreated` semantics — see above.
- The brief's campaign scoping — owner-acknowledged design (`5a82ad3`), and it is
  hand-editable (`b6ba434`).
- No persist site added at the `atlasVideoService` charge point. That would close the
  guard-sentence false-positive surface properly, but it is the billable submit path and this
  is a diagnostics fix. The residual is documented in `seedTextTruth.js` with its reasoning:
  the signal only ever ADDS the warning, never suppresses one, so the failure direction is
  biased toward the cheap error on purpose.
