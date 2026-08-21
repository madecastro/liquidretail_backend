# UI coverage audit — 2026-08-21

Produced in answer to the owner's directive: *"I am not pinching pennies I want everything
tested, all UI elements, everything."* This is the inventory of what the `ui-smoke` harness
does **not** cover, plus — more importantly — what it *appears* to cover but cannot actually
fail.

## ⚠️ Provenance and trust level

These four files are **raw Grok (`grok-4.6`, `--effort high`) output, NOT independently
verified.** They are committed because they are dense, specific, and cite `path:line`
throughout — and because they lived only in `/private/tmp`, which is disposable. **Spot-check
any citation before acting on it.** Several claims below were spot-checked and held; most were
not checked at all.

One methodological note worth keeping: an earlier attempt at this audit was run as a single
Grok call that fanned out to its own subagents, and their stdout **interleaved**, corrupting
~2400 lines into unusable spliced-together headings. These four were re-run as separate
area-scoped calls each instructed *"do not spawn subagents, produce ONE final report."* That
fixed it. Do not redirect a fan-out Grok run's stdout to a single file.

| file | area |
|---|---|
| `A-generate-ads-wizard.md` | Generate Ads wizard, all steps, PlatformFormatPicker, spend line |
| `B-productads-and-six-surfaces.md` | `/product-ads` + the six surfaces importing `AdThumbnail`/`AdDetailModal` |
| `C-remaining-pages.md` | `/home`, `/brand`, `/integrations`, `/catalog`, `/detect`, `/media-library`, `/render-activity`, `/team`, `/settings`, `/upload`, `/onboarding/*` |
| `D-harness-self-audit.md` | the harness itself: vacuous assertions, waits, skips, `optIn`, budget guard |

## The finding that matters most: why the page assertions fired mid-load

`ui-smoke` reported `/campaigns` and `/product-ads` failing because the page still showed
`Loading...` when asserted.

**Root cause, VERIFIED BY ME (not just by the audit): `suites/pages.js` performs no settle
wait at all.** Grepping it for `waitGone` / `waitUntil` / `settle` / `networkidle` returns
**zero hits**. It asserts page text immediately after navigation, so on any page whose body
arrives asynchronously it is racing the spinner. That is the whole explanation, and it is a
**test defect, not a product defect**.

⚠️ **The audit framed this differently and I initially repeated its framing — it is worth
recording the correction.** D (§b) attributes the failure to a vacuous wait: `journeys.js:682`
does `waitGone(run, 'Loading...', 15000)` with an ASCII `...`, while the SPA renders a
**unicode ellipsis** (`ProductAds/index.tsx:443` and `Step2Picker.tsx:1380` both
`Loading products…`; `BrandPicker.tsx:52` `Loading brands…`), and `hasText` does not fold
`…` ↔ `...`. **That ASCII wait IS vacuous — verified.** But it is *harmless there*, because
`journeys.js:681` does `waitGone(run, 'Loading products…', 30000)` with the correct unicode
character immediately before it. So the journeys are protected, and the vacuous line is dead
weight rather than the cause.

The failures were in `pages.js`, which has no wait of either kind. Fix that first — then
re-measure whether these pages are *also* genuinely slow at 837 products, which this masks.

## Assertions that CANNOT FAIL — worse than gaps, because they read as coverage

1. **Page-level `expectText` on a word that is also in the sidebar nav.** `/brand` asserts
   only `"Integrations"` — which is primary nav (`routes.ts:28`) *and* a card heading. A
   `/brand` body stuck on `"Loading brand…"` still passes. **Same structural bug for
   `/campaigns` (`"Campaigns"`) and `/product-ads` (`"Product Ads"`)** — the nav contains
   those strings. Three "passing" page checks prove only that the shell rendered.
2. **`expectText` with empty text silently vanishes** — `assert.js:162-164, 393-397` `return`
   with **no pass, no fail, no skip**. `selector-lint.js:114` also `continue`s on empty. The
   check cannot fail and does not even appear in the report.
3. **`expectNoFailedRequests` cannot fail on missing product images.** `BENIGN_REQUESTS`
   includes `/net::ERR_BLOCKED_BY_ORB/i` (`assert.js:80`) with an in-file admission that the
   entry is unproven. That silences a whole defect class while reading as "no failed requests".
4. **KPI tiles on `/product-ads`** (Ad Coverage, Good Opportunities, Ads Created, Ready to
   Export) render their labels on first paint with `—` placeholders (`:375-398`). `pages.js`
   asserts the labels with **no settle wait**, so the numbers are never checked. `journeys.js`
   documents this exact trap at `:669-680` and then asserts the labels anyway.
5. **Backend gate is vacuous for the mapper-drop class.** `verifyStageVisibility.js` B1 only
   regexes `$project` bodies (`:103-126`), so it cannot catch a field dropped by a per-surface
   expansion mapper — which is the actual bug shape on the six shared surfaces.
6. **`/campaigns/:id` is never tested at all** — `run.js:236-241` skips any route containing
   `/:param`, and the selectors it would use are themselves vacuous.

## Highest-leverage additions (per B)

A `/product-ads` case that **expands a row and asserts the tile, the resting status pill, and
the modal fields** is worth ~6x, because `AdThumbnail`/`AdDetailModal` are imported by six
surfaces. A second case on `/campaigns` expand proves the twin mapper. The per-surface
adapters (`adRowToExpansionAd`, `toExpansionAd`, `adListEntryToExpansionAd`) are the same bug
class, and B flags the `/home` ResourceCard path as having an agent `.select` that **omits a
field** — worth verifying first, since that is a live defect if true.

## Cross-reference

The four UI failures these audits explain are recorded in
`session.d/2026-08-21_HANDOFF-session-2-qc-validated-and-three-authz-holes.md` §5.2, including
the one genuinely money-facing item (the format picker quoting 2 video generations where the
five-conjunct rule implies 3 on the current shipped config — a possible ~$0.90/product
under-quote). A `and-verify` workflow was still running at session end and its conclusions were
never collected, so **§5.2 remains unconfirmed**; these audits are independent evidence toward
the same questions, not a substitute for confirming them.
