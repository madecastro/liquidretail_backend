# Unearned badge claims — the LLM door PR #138 left open

Branch `fix/badge-claims-truthfulness`, off `a3f93452`. **Not merged, not deployed.**

## What was wrong

PR #138 (`bf0fd397`) removed the hardcoded `{ type:'literal', value:'Bestseller' }`
from `metaCascadeConfig.js`'s `badgeText` cascade — a false-advertising claim that
fired precisely when the product had no evidence — and added
`scripts/verifyNoUnearnedClaims.js` to guard it.

**That harness scans cascade LITERALS only, so it never saw the other door into the
same slot: the badges array the derivation LLM writes.** The prompt
(`services/layoutInputService.js:1247`) asked for 2–4 badges with a *soft*
preference ("Prefer real signal over filler") and handed the model `"Top rated"`,
`"Editor's pick"`, `"Best seller"` as examples. Same defect
`scripts/verifyCopyCasing.js` documents for `"MEET THE"`: the model was not
inventing the phrase, it was copying it off the page.

## Blast radius — measured on prod, not estimated

Read-only Render job against the live DB. Of 1,345 LayoutInputArtifacts with
non-empty badges:

| | count |
|---|---|
| ≥1 unearned standing claim | **949** |
| …with `rating` AND `reviewCount` both null | **676** |
| no product link | 59 |

Occurrences: `top rated` ×741, `best seller` ×438, `customer favorite` ×143,
`fan favorite` ×68, `community favorite` ×40, `editor's pick` ×34,
`community fave` ×24 — plus fabricated NUMBERS: `4.7★ rated` ×36,
`4.8★ rated` ×31, `4.6★ rated` ×20, and `"5-Star Quality"`.

The reported case checks out. CatalogProduct `6a7b72f4935d0a8e81905544`
("Custom Cut & Sew Bode Puffer Jacket", Marine Layer 2) has
`productReviews.rating: null`, `reviewCount: null`, `ratingSource: null`,
`ratingCandidates: []`, empty description, and no key matching
`/rank|seller|sales|units|popular/`. It has 13 artifacts; `6a862136b31cf7b2214a2945`
carries `["Top rated","Best seller","Sustainably made"]`, siblings carry
`"Customer favorite"`, `"Editor's pick"`, `"Best seller"`.

**One correction to the report:** `"Sustainably made"` is *not* unearned. That
product's own `productReviews.quotes` include "This 100% recycled, water resistant
fabric feels ridiculously soft…", which is page copy the prompt is given. Two of
the three claims were false, not three.

## Why a prompt fix alone could not work

1. **`buildMetaForAd` serves stale artifacts on purpose.** Its own comment says
   "Schema freshness is a PREFERENCE, not a filter" (722 of 738 artifacts were
   pre-4.1). So bumping `INPUT_SCHEMA_VERSION` does **not** stop the 676 existing
   artifacts from printing — only a read-time gate or a data backfill does.
2. **`badgeText` binds `input.product.badges[0]`** — element 0 is what Remotion
   burns in. **`deliveryLine` binds `badges[1]`**, so a superlative in slot 1 could
   print as a *shipping* promise. The whole array has to be filtered, not just [0].
3. **A prompt rule is advisory.** This is a legal claim, so it needs a deterministic
   gate, not a stronger instruction.

## There is no sales data in this model

`models/CatalogProduct.js` has no rank, units-sold, bestseller or award field. Its
`sellers` field is aggregated Google-Shopping **merchant** listings (which retailers
stock the item), not a rank. So sales / award / editorial / popularity claims can
**never** be earned here and are dropped unconditionally, however good the rating is.
Rating and review claims are *gated on a real number* rather than banned, at the same
4.5 / 100 / 1k / 10k thresholds `defaultBadgesFromSignal` already used. A *numeric*
claim may not overstate: `"4.9★ rated"` against a real 4.6 is dropped, `"4.5★ rated"`
against a 4.6 is kept (understating is honest).

## The fix — three layers, ONE lexicon

`services/badgeClaims.js` is new and is the single source of truth
(`UNEARNED_CLAIM`, `classifyBadgeClaim`, `filterUnearnedBadges`). Both gates and the
harness import it; a second copy is exactly how this door stayed open while `C2`
stayed green, so that is called out in the header.

1. **Prompt** (`layoutInputService.js` ~1228, ~1247) — the superlative examples are
   *deleted*, not reworded, and the replacement states a prohibition rather than a
   preference. Brand mode also lost `"Family-owned since 2003"`: nothing in the
   prompt supplies a real founding year, so the model could only fabricate one.
2. **Producer gate** (`assembleInput` merge seam) — filters LLM badges **before**
   the merge, so an invented superlative cannot occupy element 0.
   `defaultBadgesFromSignal` output is filtered too — a no-op today,
   belt-and-braces against a later edit breaking its gating. Dropped badges are
   `console.warn`ed with the product id and reason.
3. **Read gate** — `gateLayoutInputBadges` in `brandScriptExecutor.js`, a sibling of
   `gateLayoutInputQuotes` placed right after it, for the **676 artifacts already in
   Mongo**. Local clone only, never mutates the document, never throws, fails closed,
   and gates on the artifact's own `social_proof.rating_value` / `review_count` — the
   very numbers the same ad prints in its proof bar, so badge and proof bar cannot
   disagree and no extra DB read happens at titling time.

Also fixed on the way through:
- **`show_badges`** (`:3065`) keyed off `derivation.badges` (raw LLM) instead of the
  array actually written. That was **already** a bug: rating 4.8 with no LLM badges
  produced `badges:['Top rated']` alongside `show_badges:false`. Now reads
  `derivedBadges`, closing both directions.
- **A comment that had become false.** `buildMetaForAd` said the stale artifact's
  "only unsafe field is the unstamped primary_quote". That would have licensed the
  next session to skip this gate; it now names both gates.

## Verification

`scripts/verifyNoUnearnedClaims.js` extended **6 → 591 checks**:
- **D** filter behaviour, incl. the load-bearing one: `"Best seller"` is dropped even
  with `rating 4.9` AND `reviewCount 5000` — a sales claim is not a rating claim.
- **E** every badge `defaultBadgesFromSignal` mints survives the filter (with an
  `E0` guard so the loop cannot pass vacuously).
- **F** the prompt no longer teaches the literals — enumerating the **real template
  registry**, per this repo's own lesson in `verifyCopyCasing.js` ("a check that
  cannot reach the code it guards is not a check"), plus `F6` asserting the badges
  line was actually reached in every pair.
- **G** structural, comment-stripped source pins on the producer wiring (the filter
  is called, and called *before* the merge; `show_badges` reads `derivedBadges`),
  because `assembleInput` awaits Mongo and cannot run offline — same answer
  `verifyDirectorRoundPersist.js` gave for `directConceptsRound`.
- **H** the read gate driven for real on hand-built artifacts, incl. no-mutation,
  identity early-out, absent-key (not `[]`) representation, non-array withholding,
  and `H9` source pins on the call site so a stubbed wire cannot leave H green.

`G6` caught a genuine flaw in its own first cut: the pin matched the word
`show_badges` inside the comment that landed with the change and read the value as
`"false."`. Comment lines are now stripped before any G/H pin reads the slice — a
source pin that reads its own documentation proves nothing.

**Every new check hand revert-proven on 14 mutations**, each firing on the intended
sections: re-added cascade literal (C1/C2), softened filter (D2/D19/D20), loosened
separator/apostrophe classes (D20), unearned default badge (E), restored prompt
example (F2/F3/F5), restored founding year (F2/F7), reclassified `"5-Star Quality"`
(D8/D11/D13/D14), reverted `show_badges` (G6), unwired the producer filter (G3),
moved the filter after the merge as a valid refactor (G2), no-op read gate
(H1–H5/H7), deleted call site (H9), in-place mutation (H1/H2), locally
re-implemented lexicon (H1–H5).

Full offline suite **164/164**. Lint clean on all 5 touched files.

## Delegation and what it cost

Grok (`grok-4.6`, high effort) drafted `badgeClaims.js`, the six
`layoutInputService.js` hunks, the read gate and the harness sections. Its draft
passed **178 independent adversarial assertions** written before it was read — then
a probe of forms a model plausibly emits found **8 real escapes**:
`"Best-Seller"` / `"Best-seller"` (hyphen instead of space — the exact claim #138
removed), `"Top-seller"`, `"Editor’s pick"` / `"Editor’s Choice"` (U+2019, which
models emit constantly), `"No. 1"`, `"No.1 seller"` — plus missing sales-velocity
wording (`"Sells out fast"`, `"Selling fast"`, `"Flying off shelves"`) and
popularity wording (`"Most Loved"`, `"Trending now"`). Separator classes are now
`[-\s]?`, possessives `['’ʼ]?`, and each form is pinned individually in `D20`,
since that is what a regex regression actually looks like.

Its own risk list flagged three more that were fixed rather than accepted: a
non-array `badges` value returning by identity (the cascade reads `badges[0]`, so an
array-like `{0:'Best seller'}` would have resolved to the claim — now withheld), a
dirty `proof_badges` riding through on a clean `product.badges`, and a
double-fault if `reseat` itself threw inside the catch.

## Residual / deliberately not done

- **The 676 stored artifacts are NOT rewritten.** The read gate neutralises them at
  titling; the stored data is still dishonest, and `routes/layout.js` previews return
  the raw array. A backfill script was not written — it mutates production data and
  needs an explicit go-ahead.
- **Attribute-claim grounding is untouched and still open.** `"Sustainably made"`,
  `"Eco-friendly"`, `"100% Recycled"` classify `neutral` and survive. Gating those
  against the product's own description is a different problem (and a regulated one
  — FTC Green Guides).
- **Brand-mode rating signal is not threaded** into the producer filter
  (`ident.details` is usually empty on `brand_match`), so a brand-rating-backed
  numeric badge would be dropped. Fail-safe, but a real narrowing.
- **Non-falsifiable puffery is deliberately neutral** (`"Premium quality"`,
  `"Built to last"`, `"Buttery soft"`). The line drawn is falsifiable-standing-claim
  in, puffery out; that is stated in the module header so it is a decision, not an
  oversight.
- Peer-session check before starting: `.worktrees/cost-run-attribution` has
  `layoutInputService.js` dirty (threading `campaignRunId` into `runDerivation`) at
  lines ~285/372/886. **No overlap** with this change's ~1228/1247/2823/3127.
