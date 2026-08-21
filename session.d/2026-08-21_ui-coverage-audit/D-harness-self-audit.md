I'll audit the harness itself from the real files you named — no subagents, no edits — and start by reading `session.md` plus the listed suites, runner, assert, lint, budget, and inventory.Next I’ll read the suite files, harness modules, inventory, and `run.js` so every claim can be tied to real line numbers.`journeys.js` was truncated mid-suite, so I’ll finish that file and then check wait/skip/`optIn` plumbing plus the budget self-tests.I’ll confirm shell chrome, loading copy, and stable hooks in the SPA so “cannot fail” claims rest on what actually renders.# Harness audit: vacuous assertions, waits, skips, `optIn`, budget

No files edited. No subagents. Claims below are **VERIFIED** from the files you named unless marked **INFERENCE**.

The harness does not use CSS/`data-testid` hooks. `selector-lint.js` only accepts `page.selectors[]` as source literals (or `{ text, dynamic: true }`). The SPA has **one** `data-testid` in the whole tree (`pages/Ads/__harness__/visionQc.tsx`) — every operator control is an unhooked Chakra node. Sketches below are visible-text needles the linter would accept.

---

## (a) Existing assertions that CANNOT FAIL (vacuous)

These are worse than gaps: they increment `passed` and paint coverage.

### A1. `pages.js` body-text checks that match the **sidebar on every shell page**

`hasText` is a case-insensitive substring of `document.body.innerText` (`harness/runner.js:263-268`). `PipelineShell` mounts `Sidebar` on every authenticated app route (`App.tsx:43-83`, `PipelineShell.tsx:16`). Sidebar always contains:

| Needle | Always-on source | pages.js uses it as if it were the page |
|---|---|---|
| `Integrations` | `routes.ts:29` STEPS | `/brand` (only selector, `pages.js:61`), `/integrations` (`pages.js:80`) |
| `Campaigns` | `routes.ts:29` | `/campaigns` (`pages.js:97`) |
| `Product Ads` | `routes.ts:30` | `/product-ads` (`pages.js:147`) |
| `Detect Review` | `SECONDARY_NAV` `routes.ts:49` | `/detect` (`pages.js:225`) |
| `Render Activity` | `routes.ts:51` | `/render-activity` (`pages.js:263`) |
| `Team` | `routes.ts:52` | `/team` (`pages.js:283`) |
| `Settings` | `routes.ts:53` | `/settings` (`pages.js:307`) |
| `Sign out` | `Sidebar.tsx:91` | `/onboarding`, `/onboarding/workspace` (`pages.js:447`, `463`) |

**VERIFIED:** `/brand` asserting only `"Integrations"` cannot fail unless the whole shell is gone. A `/brand` body stuck on `"Loading brand…"` (`Brand/index.tsx:145-146`) still has sidebar `Integrations`. Same for `/campaigns` `"Campaigns"` and `/product-ads` `"Product Ads"` while the table still shows `"Loading campaigns…"` / `"Loading products…"`.

`/onboarding` is **outside** `PipelineShell` (`App.tsx:86-94`). The mint user has an advertiser, so `OnboardingPage` redirects to `/brand` when `hasAdvertiser` (`Onboarding/index.tsx:46`). After that hop, `"Sign out"` matches the **sidebar**. The onboarding landing copy is never asserted. Workspace page is the same pattern.

### A2. `"Meta"` / `"Google"` / `"reach-social"` on `/campaigns/:id`

`pages.js:124-126`. Sidebar Integrations description is `'Connect Meta, Google, IG, Shopify'` (`routes.ts:29`). **VERIFIED:** `"Meta"` and `"Google"` are in `innerText` on every shell page. This case is also **skipped** before navigation (A6), so the selectors never run — they still **read as coverage** in the inventory.

### A3. Empty `selectors: []` — visit + console/network only

`runPage` loops `page.selectors` then `expectNoConsoleErrors` / `expectNoFailedRequests` (`run.js:286-307`). Empty list → **zero content assertions**.

| Route | `pages.js` |
|---|---|
| `/home` | `45` |
| `/media-library` | `245` |
| `/generate-ads?step=generate` | `380` |

**VERIFIED:** `/home` never asserts AgentChat empty state, suggestions, input, `New chat`, confirmation cards, or stream abort — all documented in `page-inventory.json:7-28` and copied into `pages.js:49-53` as comments, not checks.

### A4. KPI / PageHeader needles that render on the **loading skeleton**

Campaigns paints header + KPI tiles **before** the table load finishes (`Campaigns/index.tsx:308-361` header/KPIs; loading table at `447-452`). Product Ads same (`ProductAds/index.tsx:372-398` KPIs; loading at `442-443`). Values are `'—'` until `summary` arrives.

So these **pass on a still-loading page**:

- `/campaigns`: `"Manage campaign-level ad generation and exports at scale."`, `"Automation"`, `"Generate Ads"`, `"Campaign Coverage"` (`pages.js:98-101`)
- `/product-ads`: description, `"Ad Coverage"`, `"Good Opportunities"`, `"Ads Created"` (`pages.js:148-151`)

This is the observed `/campaigns` + `/product-ads` green-while-`Loading…` failure. Journeys J1 already documented the trap (`journeys.js:663-680`) and **pages.js did not take the lesson**.

### A5. Lint that certifies a **comment**, not UI

`generation-ui.js:168` selector `'Review & Generate'`. Rendered heading is `"Review & generate"` (`Step4Generate.tsx:423`). Lint is case-sensitive `src.includes` (`selector-lint.js:141`). The **file comment** on line 1 is `Review & Generate`, so lint passes against a comment. This suite is journey-driven so the selector is lint-inventory only (`run.js:394-400`) — it still reads as “we verified Review & Generate”.

### A6. `expectText` on empty/`null` is a silent no-op

`Checks._textOf` + `expectText` (`assert.js:162-164`, `393-397`): empty text → `return` with **no pass, no fail, no skip**. Lint also `continue`s on empty (`selector-lint.js:114`). Cannot fail; cannot even show up.

### A7. `waitGone('Loading...', …)` that never matches

J1: `waitGone(run, 'Loading...', 15000)` (`journeys.js:682`). Product Ads copy is unicode `"Loading products…"` (`ProductAds/index.tsx:443`); BrandPicker is `"Loading brands…"` (`BrandPicker.tsx:52`). `hasText` does **not** fold `…` ↔ `...`. First poll: not present → `waitGone` returns immediately. **Vacuous wait.** The real wait is the preceding `Loading products…` line (`journeys.js:681`).

### A8. `g1` “delivered” check vs the product definition of delivered

`waitForRun` settles when CampaignRun `status` is not `preparing`/`running` (`generation.js:114-115`). Then it asserts `runDoc.total === quoted.images` (`generation.js:294-297`) and looks for **any** non-logo `<img>` on **legacy** `/ads?campaignRunId=` (`generation.js:307-320`).

**VERIFIED:** it never checks ad `status === 'draft'` + non-empty `renderUrl`. A run can be “settled” with minted rows and a Cloudinary thumb while the creative is not delivered in the sense this codebase uses.

**INFERENCE:** an unrelated `<img>` on `/ads` (product/campaign chrome) can satisfy the img filter (`logo|avatar|placeholder` only).

### A9. `gui1` screen-vs-preview is not bound to the click body

`generation-ui.js:269-315` quotes a **hand-built** `{ preset:'explicit', staticFormats:['meta_feed_1_1'], videoFormats:[] }`. The click (`:329`) posts **whatever the wizard built**. Agreement between badge and that reconstructed body can pass while the click bills a different shape — the failure class this suite’s header says it exists to catch (`generation-ui.js:8-13`).

### A10. Filters that hide real network failures

`BENIGN_REQUESTS` includes `/net::ERR_BLOCKED_BY_ORB/i` (`assert.js:80`) with an in-file admission it is unproven. `expectNoFailedRequests` therefore **cannot fail** on missing Shopify-hosted product images in headless Chrome. That is a silenced defect class, not a tautology, but it reads as “no failed requests”.

### Not vacuous (can fail)

J2 spend/`aria-pressed` maths, J4 Generate enabled/disabled halves, J5 empty-state `+ New campaign` disabled, J7 signature change, `g1` HTTP status/quote, `gui1` ActivityBar appear/stall/monotonic — these have fail paths.

`checks.pass()` (`assert.js:369-373`) is a counter (`void label`), not an assertion. Harmless next to a real check; it is not coverage.

---

## (b) How `runner.js` waits before page-text asserts — and why it is not enough

**VERIFIED wait, the only one `pages.js` gets:**

```227:233:harness/runner.js
  async goto(routePath, { waitFor = 'networkidle2', timeoutMs = 45000 } = {}) {
    this.console = [];
    this.failedRequests = [];
    this.pageErrors = [];
    const url = ...
    await this.page.goto(url, { waitUntil: waitFor, timeout: timeoutMs });
```

`runPage` then immediately `expectText`s (`run.js:257-290`). There is **no** `waitGone('Loading…')`, no KPI-not-`—` wait, no `waitForText` of a loaded signal.

Puppeteer `networkidle2` = **≤2 connections for 500ms**. BrandPicker fetch (`Loading brands…`, `BrandPicker.tsx:49-53`) plus the page’s own list fetch (`Loading campaigns…` / `Loading products…`) is **exactly two in-flight requests**. Idle can fire **while both loaders are still on screen**.

That matches the observed failure: `/campaigns` and `/product-ads` asserted against header/KPI/sidebar copy that exists in the skeleton (`Campaigns/index.tsx:308-361` + `447-452`; `ProductAds/index.tsx:372-443`).

Journeys learned this and wait for **data**, not labels:

- J1: `waitGone('Loading products…')` then require `\d+%` / empty / no-brand (`journeys.js:681-693`)
- J3/J4/J5: `waitGone('Loading campaigns…')` (`journeys.js:1197-1198`, `1303`, `1501`)
- J6: wait until creative **count > 0** or empty (`journeys.js:1634-1642`) — comment calls it the “fourth instance of this suite's recurring trap”

`pages.js` has none of that. `expectNoConsoleErrors` also does not imply loaded data: a silent blank field (`apiJson<T>` unchecked cast, `apiFetch.ts:114-126`) produces no console error.

**INFERENCE:** `/brand` 5s integration poll (`page-inventory.json:62`) and `/render-activity` 4s/20s poll can keep ≤2 connections forever; `networkidle2` then fires between ticks, not after “loaded”.

---

## (c) Declared but SKIP / unimplemented

| Case | What happens | What it needs to actually run |
|---|---|---|
| **`g2-one-video-master`** | Always `markSkip` (`generation.js:356-360`). `optIn: 'video'` is unused. | Implement `run()` (preview → reserve `video_master_submit` at last moment → POST/click once → wait settle → assert **draft + renderUrl** on `/product-ads`, not `/ads`). Plus CLI gate (d). |
| **`/campaigns/:id`** | `runPage` skips any `/:param` (`run.js:236-241`) | A real id from `resolveJourneyCtx`; a journeys case. Selectors `"reach-social"/"Meta"/"Google"` would still be vacuous (A2). |
| **Billable suites at `--budget 0`** | `skipReasonForSuite` (`run.js:311-314`) | `--budget > 0` |
| **Second billable claim in one `--fix` session** | `LoopGuard.claimBillableRun` (`run.js:316-318`) | Separate process / new session |
| **Journey with no `run()`** | `markSkip('journey has no run()')` (`run.js:416-418`) | Dead API; no current case |
| **J1** | skip: no brand / no products (`journeys.js:702-706`) | Fixture brand with catalog |
| **J3/J4** | skip: no campaigns / no tiles / readiness gate (`journeys.js:1200-1201`, `1304-1305`, `1342`, `1461-1463`) | Campaign + seeds; ad-ready brand |
| **J5** | skip unless some brand has **zero** campaigns (`journeys.js:1534-1536`). `ctx.emptyBrandName/Id` is read (`journeys.js:1490`) but **never populated** by `run.js` | Wire empty-brand fixture into `runJourney` ctx |
| **J6** | skip if no rendered ads (`journeys.js:1644-1648`); walks **legacy `/ads`** | Ads on `/product-ads` (wrong surface today) |
| **J7** | skip: one brand only (`journeys.js:1760-1762`) | ≥2 brands |
| **`g1` 409 / 0-image preview / no quote** | skip/env (`generation.js:171-213`, `254-264`) | Unique body or different campaign |
| **`gui1`** | several precondition skips (`generation-ui.js:194-263`, `349`) | Walkable wizard + distinct request |

`self-test.js` **does not import `selector-lint`** despite the file header (`self-test.js:8-9`). Lint regressions are untested.

---

## (d) `optIn: 'video'` is **not** gated by any CLI flag

**VERIFIED.** `parseArgs` keys (`run.js:69-82`, `91-111`): `--suite`, `--budget`, `--budget-id`, `--email`, `--brand`, `--base-url`, `--headed`, `--max-iterations`, `--fix`, `--list-suites`, `--help`. No `--opt-in`, `--video`, `--include-video`. `USAGE` (`run.js:41-67`) does not mention video.

`runJourney` stuffs `optIn: journey.optIn \|\| null` into `ctx` (`run.js:432`) and **nobody reads `ctx.optIn`**. `g2` ignores `ctx` (`void run; void ctx`, `generation.js:355`) and always skips.

Plumbing that is missing, exactly:

1. **CLI:** parse `--opt-in video` (repeatable or csv), put `optIns: string[]` on `opts`. Document in `USAGE`.
2. **Gate in `runJourney` (before `journey.run`):** if `journey.optIn` and `!opts.optIns.includes(journey.optIn)` → `markSkip('opt-in "video" not requested')`. Do **not** rely on the stub skip.
3. **Do not treat `--budget > 0` as video consent** — `g2` comment (`generation.js:335-337`) is explicit that a static probe must not silently buy a ~$1.20 Omni master.
4. **Implement `g2.run()`** only after the gate exists; reserve `video_master_submit` at the last moment before the request (see e).
5. **Optional:** require `ceilingUsd` ≥ `UNIT_COST_USD.video_master_submit` (`1.20`, `budget.js:82`) or skip with a distinct reason.

Prior pass was correct: it is not gated.

---

## (e) Budget: reserve-before-request, and leak paths

**Reserve-before-request is real for the two live spenders.**

- Guard writes the ledger **before** return (`budget.js:255-285`). Dry-run / ceiling-exceeded throw **before** `writeLedger` (`227-253`).
- `g1`: `guard.reserve(STATIC_SUBMIT, quoted.images, …)` then `postJson('/api/ads/generate', previewBody)` (`generation.js:225-248`). Same body as the quote (`buildGenerateBody`).
- `gui1`: `guard.reserve` then `clickText('Generate Ads')` (`generation-ui.js:320-329`).
- `g2`: **does not reserve**. Comment is the post-mortem of the leak this self-test exists for (`generation.js:341-350`; `self-test.js:21-22`). Current stub cannot leak.

`release()` zeros `r.usd` but keeps the row (`budget.js:337-355`). `spentUsd()` sums `r.usd` (`budget.js:162-166`), so a released row does not consume ceiling. 409 paths in `g1` (`generation.js:258-260`) and `gui1` (`generation-ui.js:330-348`) call `release` with a ≥8-char reason.

### Paths that reserve then return without `release` (append-only leak)

| Path | Live today? | Verdict |
|---|---|---|
| `g2` stub reserved then skipped | **No** — fixed | Historical |
| `runPage` `reserveForPage` then `goto` throws (`run.js:244-261`) | **Dead** — no `pages.js` entry sets `reserve`/`operation` | Would leak if anyone added `page.reserve` |
| `g1`/`gui1`: `reserve` succeeds, then `page.evaluate`/`click` **throws** | **Yes** | `runJourney` catch → `markEnv`, **no release** (`run.js:435-440`) |
| `g1` non-202/non-409 after POST | Request was sent | **Correct** not to release (Atlas bills at submit) |
| `gui1` click miss / duplicate dialog | Releases | OK |

**VERIFIED leak remaining:** any exception between `reserve()` and a structured 409/no-submit proof is a permanent debit. `self-test.js` covers `release()` on a fake 409 (`109-116`) and does **not** cover “reserve then throw”.

`summary().remainingUsd` uses `this.ceilingUsd - spent`, not `effectiveCeilingUsd()` (`budget.js:359-366`) — reporting lie, not a spend leak.

---

## Coverage map (harness vs app states)

Legend: **COVERS** = assertion that can fail on the thing named. **VISITS** = navigates, maybe console/network. **DOES NOT** = not exercised. “No console error” is not coverage.

### `pages.js` (free, `runPage` only)

| Route | Interactive / states (from inventory + source) | Harness |
|---|---|---|
| `/home` | Chat empty, suggestions, Send/Stop, New chat, ConfirmationCard, stream abort, no-brand copy, error banner | **VISITS** (empty selectors) |
| `/brand` | Loading / error / no-brand / full cards / onboarding banner / OAuth bounce / SaveBar | **DOES NOT** (sidebar `"Integrations"` only). Loading/error/empty untested |
| `/integrations` | Loading brand, error, cards, missing null-brand empty | **VISITS**; `"Connected integrations"` can fail; `"Integrations"` cannot |
| `/campaigns` | Loading table, empty, KPIs with real %, filters, expand, Generate disabled, Sync, `?new=1` modal | **VISITS** skeleton. **DOES NOT** empty/error/expand/filters/disabled |
| `/campaigns/:id` | Loading, read-only Meta/Google, delete confirm, tabs empty | **SKIP** pattern |
| `/product-ads` | Loading, empty, real KPI %, row expand, AdDetailModal, bulk bar, regenerate, exported lock, 12-tile cap | **VISITS** skeleton. **DOES NOT** expand/modal/empty-as-assert (empty would **fail** `"Ads Created"` if KPIs missing — they are not missing on load) |
| `/ugc-ads` | Loading UGC, empty filter, chips, expand, Convert, `?mediaId=` | **VISITS** header/chips. **DOES NOT** empty/expand/wizard |
| `/catalog` | Sidebar filters, `"No product selected"` vs loaded detail, `"Loading product…"`, `"Could not load product"` | **FLAKY VISIT**: `"No product selected"` is the **unselected** pane (`CatalogBrowser/index.tsx:104`). Auto-select-first makes it transient on a full catalog |
| `/detect` | Loading…, empty drafts, graduate disabled without title | **VISITS** chrome (`"Drafts only"` is page-local, can fail). Empty/error **DOES NOT** |
| `/media-library` | Empty, canvas layers, delete confirm | **VISITS** |
| `/render-activity` | Brand loading spinner (no text), no-brand, error, stalled, poll #13 | **VISITS** header buttons. Loaded rows / stalled / error **DOES NOT**. Headless `visibilityState` regression **DOES NOT** |
| `/team` | Loading…, invite form, cannot-demote-owner, `window.confirm` | **VISITS** invite copy (owner-shaped). Error/empty/revoke **DOES NOT** |
| `/settings` | Coming soon + Delete Account modal | **VISITS** static stub. Modal **DOES NOT** (and must not click Delete) |
| `/generate-ads` | Picker, empty campaigns, Next disabled | **VISITS** picker labels. Empty/Next **DOES NOT** (J2/J3/J5 cover some) |
| `?step=products` | Ribbons, empty catalog, Next enable | **VISITS** three strings. Empty/pre-pick **DOES NOT** (J3 partial) |
| `?step=generate` | Review, seed=0, noFormat, 409 modal, gate | **VISITS** (empty selectors). J4 covers walk-up; 409 **DOES NOT** in free tier |
| `/ads` | Legacy gallery | **VISITS** (out of product scope; J6/g1 still use it) |
| `/upload` | Placeholder | **VISITS** static |
| `/onboarding*` | Eligibility branches, URL validation, OAuth | `/onboarding` + `/workspace` **vacuous** after redirect. `/brand` + `/connect` unique copy **can fail** if bounced to `/brand` |
| `/ugc-wizard`, `/sales-demos`, `/landing`, `/invite/:token` | — | **DOES NOT** even visit |

### `journeys.js` (the only real free coverage)

| Journey | COVERS | DOES NOT |
|---|---|---|
| **J1** | Product Ads **settled** (not skeleton) → row Generate Ads → `step=campaign` + picker | Expand, AdDetailModal, bulk bar, empty (skip), readiness-disabled Generate |
| **J2** | Presets, Clear, spend vs badge, Meta+PMax combo, Meta video=1, Advanced multi-select, coming_soon inert, PMax Video Square derive-only | VideoControlsStrip, ExpressGenerateBar click (denylisted), fallback catalog (env) |
| **J3** | Campaign radio → Next enables → step 2; tile enables Next | Empty ribbons as fail, related-media tiers, video-seed pre-pick, brand-kind vs product-kind as distinct |
| **J4** | Review heading; Generate **disabled** with no format then **enabled** after Meta static; counts; **does not click Generate** | 409 modal, `noFormatSelected` vs `seedCount===0` as two disables (only the first half of that), deep-link step=generate |
| **J5** | Wizard empty `+ New campaign` **enabled**, modal fields, Cancel | Campaigns-page empty; actually creating (correct) |
| **J6** | Legacy `/ads` grid + detail + non-empty src | **`/product-ads` AdDetailModal** (imported by six surfaces, primary is Product Ads) |
| **J7** | Brand switch changes Product Ads **data** | Other pages’ re-scope |

### Billable

| | COVERS | DOES NOT |
|---|---|---|
| **g1** | Preview quote → reserve → POST generate → run not preparing/running → some `<img>` on **`/ads`** | UI button, `/product-ads`, `draft+renderUrl`, video |
| **g2** | Nothing (stub skip) | Video master |
| **gui1** | Cheap static walk + badge vs **reconstructed** preview + ActivityBar | Binding quote to wizard POST; `/product-ads` delivery; video |

---

## Gaps ranked (owner-visible × silent)

1. **`pages.js` load-race + sidebar-colliding selectors** — owner sees green while `/campaigns`/`/product-ads` still show `"Loading campaigns…"` / `"Loading products…"` / `"Loading brands…"`. Silent: KPI `'—'` + `apiJson<T>` missing fields render blank with no error. **Highest.**
2. **AdDetailModal / AdThumbnail never opened on `/product-ads`** — J6 and g1 use legacy `/ads`. Projection allowlist on `routes/catalog.js` ads-detail dropping a field goes **blank in the modal** with no harness fail. Bit the codebase 4×. Silent + owner-facing.
3. **“Delivered” never asserted as `draft` + `renderUrl`** — g1 can pass on run.total + an img. Silent money/quality miss.
4. **`/home`, `/media-library`, brand cards, catalog detail, detect empty, render-activity #13, ugc-wizard** — visit-only or unvisited. `/home` is the default landing.
5. **`g2` + missing `--opt-in`** — declared coverage that always skips; a future naïve implementer who reserves at the top of `run()` re-opens the leak.
6. **`gui1` quote ≠ click body** — can bless a wizard that still posts the wrong `videoFormats`/`preset`.
7. **`/campaigns/:id` skip** — detail/delete/read-only Meta campaigns untested.
8. **J5 empty-brand fixture never injected** — empty-state journey skip-heavy.

---

## Assertion sketches (lint-acceptable needles)

No `data-testid` to hang on. Use unique **page** copy, never STEPS labels. Wait for load **before** `expectText`.

**Gap 1 — pages must not pass on skeleton**

```js
// after goto('/campaigns') — do NOT expectText('Campaigns')
await waitGone(run, 'Loading campaigns…', 30000);
await waitGone(run, 'Loading brands…', 15000);
await checks.expectText('Manage campaign-level ad generation and exports at scale.');
await checks.expectNoText('Loading campaigns…');
// loaded XOR empty XOR error — never sidebar
const state = await waitUntil(async () => {
  if (await run.hasText('No campaigns synced yet')) return 'empty';
  if (await run.page.evaluate(() => /\d+%/.test(document.body.innerText))) return 'loaded';
  return null;
}, { timeoutMs: 30000 });
```

Same for Product Ads with `'Loading products…'` and `'Generate and manage ads for your products at scale.'` (already in lint inventory `pages.js:148`).

**Gap 2 — `/product-ads` modal (replace J6 target)**

```js
await run.goto('/product-ads');
await waitGone(run, 'Loading products…', 30000);
// click first tile — no stable hook; tiles are unlabelled imgs
// then:
await checks.expectText('Ad detail');          // lint: ProductAds/index.tsx modal
await checks.expectText('Generation details');
await checks.expectNoText('Last regenerate failed'); // unless that is the case under test
// delivered, not done:
const delivered = await run.page.evaluate(() => {
  const v = document.querySelector('video');
  const img = [...document.querySelectorAll('img')].find(i => i.currentSrc && !/logo|avatar/i.test(i.currentSrc));
  return { src: (v && (v.currentSrc||v.src)) || (img && img.currentSrc) || '' };
});
// fail if !src  — this is the renderUrl/photorealUrl hole
```

Lint-ok literals already in `journeys.js` pages inventory: `'Ad detail'`, `'Template'`, `'Aspect ratio'` (`journeys.js:619-627`) — they are currently aimed at `/ads`.

**Unhooked (flag, do not fake a testid in this audit):** ProductTile/MediaTile (`width 140–200` heuristic, `journeys.js:455-468`), FormatCard (`cursor:pointer` walk, `journeys.js:284-308`), AdThumbnail, KPI value `'—'`, BrandPicker brand name, campaign radios. Any of these breaking is invisible to selector-lint.

**Gap 3 — g1 delivery**

```js
// after run settles:
await run.goto('/product-ads'); // not /ads
// expand product, open ad
// assert visible copy from ads-detail allowlist fields you care about,
// e.g. headline text that must be in the projection
await checks.expectText(<headline from GET /api/catalog/:id/ads-detail>); // { dynamic: true }
```

If the allowlist drops `headline`/`renderUrl`, this fails; today’s img scrape does not.

---

## Direct answers

**(a)** Vacuous: sidebar-colliding `expectText`s (A1–A2), empty selector pages (A3), skeleton KPI/header asserts (A4), lint-on-comment `'Review & Generate'` (A5), empty-string `expectText` no-op (A6), J1 `waitGone('Loading...')` ASCII ellipsis (A7), g1 delivered≠draft+renderUrl (A8), gui1 unbound quote (A9), ORB filter (A10).

**(b)** Only `page.goto(..., { waitUntil: 'networkidle2' })` (`runner.js:227-232`). Insufficient: idle allows 2 connections, which is brands-fetch + page-fetch; header/KPI/sidebar copy is already painted. Journeys wait for loaders to vanish; **pages.js does not**.

**(c)** Always-skip stub: `g2`. Structural skip: `/campaigns/:id`. Conditional skips: J1/J3–J7, g1 409/empty, gui1 preconditions, billable-without-budget. J5’s `emptyBrand*` ctx is never filled.

**(d)** `optIn:'video'` is not CLI-gated. Missing: parse `--opt-in`, gate in `runJourney`, keep budget from implying video, then implement `g2` with last-moment reserve.

**(e)** Live spenders reserve before the request. `g2` no longer reserves-then-skips. Remaining leak: `reserve` then throw → `markEnv` with no `release` (`run.js:435-440`). Dead but dangerous: `runPage` reserve-then-failed-`goto`. 409 paths release correctly. Ledger rows are never deleted.
