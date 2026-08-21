# Root-cause of the four ui-smoke failures — 2026-08-21

Four real failures from a `ui-smoke` run against staging **with a fully valid session**
(advertiser + brand resolved, so these are not session artifacts). Each was investigated by
one agent, then handed to a **separate adversarial verifier** whose explicit job was to refute
it. Raw evidence is in this directory (`raw-workflow-journal.jsonl` has one result line per
agent).

This supersedes §5.2 of `session.d/2026-08-21_HANDOFF-session-2-qc-validated-and-three-authz-holes.md`,
which recorded these as UNCONFIRMED.

| # | defect | verifier verdict | what it actually is |
|---|---|---|---|
| 1 | Format picker quotes 2 video generations, test expects 3 | **CONFIRMED** | **PRODUCT defect. Real money under-quote.** |
| 2 | Wizard "Next: Generate" stays disabled | **CONFIRMED** (2 citation corrections + a fix-safety caveat) | see raw evidence |
| 3 | `/campaigns` + `/product-ads` assert while `Loading…` | **CONFIRMED** | TEST defect, not product |
| 4 | Gallery empty despite 3 delivered ads | **PARTLY-WRONG** | direction right, **mechanism wrong** — see below |

---

## 1. MONEY — CONFIRMED product defect. The picker under-quotes by one ~$0.90 master.

**The UI is wrong; the test is right.**

`frontend/app/src/pages/GenerateAds/index.tsx`:
- `videoPlateId(key)` (`:260-264`) maps **both** `meta_stories_9_16` **and** `pmax_video_9_16`
  to the same id `'shared_9_16'`.
- `countDistinctVideoPlates()` (`:273-275`) is `new Set(keys.flat().map(videoPlateId)).size`.
- For a mixed Meta+PMax "All video" pick: Meta clamps to 1 key, PMax stays 2 keys, and the two
  9:16s collapse → `{'shared_9_16','pmax_video_16_9'}` → **size 2**, rendered at `:723` as
  "2 video generations per product".

So the picker **unconditionally assumes the shared-9:16-master saving is live** the instant both
are ticked. It implements **none** of the five conjuncts.

**The truth on the currently shipped config** (read from `origin/main`, not a stale local tree):
`config/defaults.env:439-440` ships `VIDEO_HOOK_FIRST_PROMPT=false` and
`PMAX_VIDEO_DIRECTIVES=false` (the 2026-08-20 owner revert, #275). So
`isHookFirstVideoPromptEnabled()` → `false` → `isSharedPortraitPlatePromptCoherent()`
(`campaignAdsGenerationService.js:583-585`) → `false` → `resolvePortraitMasterFormat()`
(`:659-682`) returns `PMAX_VIDEO_DERIVE_SOURCE`, i.e. **not shared**. Conjuncts 1, 2, 3 and 5
all hold; **conjunct 4 fails closed.**

→ **A mixed Meta+PMax run bills THREE masters / $2.70 per product today, and the UI says 2.**

**The test is not stale.** `journeys.js:960-970` derives its expectation dynamically as
`1 (Meta) + both.pmaxVideo.masterCount` — it asserts the headline should equal the sum of the
picker's own two per-platform badges (PMax's badge already correctly shows 2). The headline
disagreeing with its own badges is the bug.

**Why the frontend cannot fix this alone.** `GET /api/ads/formats` → `formatCatalog()`
(`services/platformFormats.js:1011-1041`) publishes only
`key, label, aspectRatio, deliveryDims, kinds, status, safeAreaPct` — nothing about the flags.
`platform.listFormats` is the same function. The flags are live, deploy-free env toggles, so
any hardcoded client constant goes stale on the next flip.

The code's own comment already admits this (`index.tsx:253-259`): it *"mirrors the
DEFAULT/steady-state backend outcome, not every runtime conjunct… that is exactly why
`/api/ads/preview` remains the operator's real quote."*

**The conjunct-aware answer already exists**: `POST /api/ads/preview` (`routes/ads.js:328-403`,
`dryRun:true`) returns `billable.videoMasters`
(`campaignAdsGenerationService.js:1690-1696`) — and **Step4Generate.tsx already consumes it**.
The *picker* screen (Step 2/3), where the spend line lives, never calls it.

**Fix options:** either have the picker call `/api/ads/preview` for its headline (reuses the
existing conjunct-aware path), or publish a `sharedPortraitMasterEligible` boolean from the
backend. The first needs no new backend field.

---

## 4. Gallery empty — PARTLY-WRONG, and the correction matters

The verifier spot-checked ~12 citations and found **no fabrications** — the investigator really
read the code. Its top-line call ("test defect, wrong page") is directionally right: **j6
navigates to `/ads`** (`journeys.js:1612`), which is the **LEGACY do-not-develop gallery**, not
the primary `/product-ads` surface. So the case is testing the wrong page.

But the investigator's *mechanism* for ruling out a render race was **demonstrably wrong**, and
the verifier found a deterministic explanation the investigator missed:

- `Ads/index.tsx:546` seeds `loading = useState(false)`, whereas `ProductAds/index.tsx:251`
  seeds `useState(true)`. **That asymmetry is the whole story.**
- The fetch effect opens `if (!activeBrandId) return;` (`Ads/index.tsx:751,759`), so `loading`
  never flips true while `activeBrandId` is null.
- `activeBrandId` derives from `BrandContext`, whose `brands` starts `[]` and is populated only
  after **two sequential awaited fetches** (`/api/me` then `/api/brand`, `BrandContext.tsx:71,89`).
  So `activeBrandId` is **guaranteed null on every mount** until that round-trip finishes.
- `AdsPage` has no brand-gated early return, so during that window it renders `!loading` with
  no ads → an empty state, **deterministically on every load**, not as a rare race.

So: fix j6 to target `/product-ads`, and treat the `useState(false)` asymmetry on the legacy
page as the reason the empty state is reachable at all. **The 3 delivered ads were never shown
to be invisible on the primary surface** — that question is still open and worth answering
directly, since it is the historically worst failure class here.

---

## 3. Loading stall — CONFIRMED test defect

Consistent with the separate coverage audit (`session.d/2026-08-21_ui-coverage-audit/`):
`suites/pages.js` performs **no settle wait at all** (zero `waitGone`/`waitUntil`/`networkidle`).
Not a product defect. Fix the wait, then re-measure whether these pages are *also* genuinely
slow at 837 products — the missing wait currently masks that question.

---

## Method note

The investigate → adversarially-verify split earned its cost here: it caught a wrong mechanism
in #4 that a single pass would have shipped as fact, and it independently re-derived the money
claim in #1 from the real config rather than from the docs. Note the verifier also flagged that
a local backend checkout was **stale by 10 commits** and re-read everything from `origin/main`
— worth copying, since a stale tree would have made the money verdict come out backwards.
