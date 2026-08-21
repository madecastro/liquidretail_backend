I'll audit the Generate Ads wizard against the real frontend and harness, reading the code myself and citing path:line for every claim. First I'll load session state, the ui-smoke skill, and the wizard plus harness files.Grok CLI is available; I'll read the wizard, picker, and harness suites next so coverage claims can be cited from the real code.The picker arithmetic is in `index.tsx`; next I’ll read the wizard shell, Step 2’s Next-button gate, Step 4, and the harness suites that claim to cover them.The 2-vs-3 video-count mismatch looks like shared-plate dedupe vs the test summing Meta+PMax. Next I’ll read Step 2 tiles, Step 4 gating, and the rest of J2–J4.J3 clicked `ACTIVE BRAND` (sidebar), not a product tile — that explains the stuck Next button. I’ll confirm backend plate-sharing, the rest of Step 2, and what `pages.js` actually asserts.**Coverage of the Generate Ads wizard is a mix of a strong picker journey (J2) that is currently asserting the wrong video total, and a Step 2 walk (J3/J4) that never selects a product.** The last free-tier run failed J2 (`2` video generations vs expected `3`), J3 (`Next` still disabled after a “tile” click), and J4 (could not leave products). Those two observed failures are explained by the real code below.

No files were edited. Claims are marked **VERIFIED** (path:line) or **INFERENCE**.

---

## How the wizard actually works (verified)

Three URL steps: `campaign` → `products` → `generate` (`STEPS` at `frontend/app/src/pages/GenerateAds/index.tsx:1144-1148`). Settings was dropped; `Step3Settings.tsx` is dead (only exports itself; `index.tsx` imports Step1/Step2/Step4 only).

`PlatformFormatPicker` is **persistent on every step**, not inside a step body (`index.tsx:1383-1400`). Default selection is **empty** (`staticFormatKeys: []`, `videoFormatKeys: []` at `index.tsx:1200-1216`).

Footer **Next** is gated by `canProceed` (`index.tsx:1343-1354`, bound at `1436-1438`):

| Step | Enables Next when |
|---|---|
| `campaign` | `!!selections.campaignId` |
| `products` | `productIds.length > 0` **OR** `mediaIds.length > 0` **OR** `campaignKind === 'brand'` |
| `generate` | Next is not rendered (`step !== 'generate'` at `1435`) |

**Generate Ads** (Step 4) is a different button, gated by `gateDisabled \|\| seedCount === 0 \|\| noFormatSelected` (`Step4Generate.tsx:176-180, 513`). `seedCount` is `productIds + mediaIds` only — **not** `seedPicks`, **not** brand-kind. Brand-kind can pass Step 2 with zero picks and then sit on a disabled Generate.

`apiJson<T>` is an unchecked cast (`frontend/app/src/auth/apiFetch.ts:114-126`). A missing field renders blank, no throw.

---

## 1. Interactive elements and states, with coverage

Coverage key: **COVERS** = a journey asserts the behaviour (not just that a string exists). **VISITS** = page load / `hasText` / lint list, no behaviour. **DOES NOT COVER**.

### Wizard chrome (every step)

| Element / state | Source | Coverage |
|---|---|---|
| PageHeader “Generate Ads” / “New ad batch” | `index.tsx:1375-1378` | **VISITS** — `pages.js` + J1 `expectText` |
| Stepper Campaign / Products / Generate; brand-kind relabels step 2 to “Media” | `index.tsx:1144-1158, 1566-1606` | **VISITS** label only. Brand-kind “Media” label: **DOES NOT COVER** |
| Cancel → `/campaigns` | `index.tsx:1428-1429` | **DOES NOT COVER** |
| Back | `index.tsx:1432-1433` | **DOES NOT COVER** |
| Next: `{next label}` disabled/enabled | `index.tsx:1435-1438` | J3 **intends** to cover; last run **did not** (see Gap 1) |
| Legacy `?step=settings` → `campaign` | `index.tsx:18-22, 1183-1184` | **DOES NOT COVER** |
| Switching an already-selected campaign wipes picks | `index.tsx:1315-1332` | **DOES NOT COVER** |

### PlatformFormatPicker (money UI)

| Element / state | Source | Coverage |
|---|---|---|
| “Everything (Meta + PMax)” capstone | `index.tsx:611-645` | **VISITS** (text + `hasEverything`). **Never clicked** |
| Meta/PMax “All static” / “All video” | `index.tsx:677-700` | **COVERS** combinability + Meta-static spend (J2) |
| Clear | `index.tsx:587-598` | **COVERS** (J2) |
| Empty spend: “Pick at least one size…” | `index.tsx:712-713` | **COVERS** (J2) |
| `{n} image generation(s) per concept` | `index.tsx:717-719` | **COVERS** vs Meta All-static badge (J2) |
| `{n} video generation(s) per product` | `index.tsx:721-724` | **COVERS, currently FAILING** — test sums badges, UI dedupes plates (Gap 2) |
| Meta “one 9:16 master… free 1:1/4:5/Reels” copy | `index.tsx:734-737` | **DOES NOT COVER** (J2 checks the **count** 1, not this sentence) |
| PMax “9:16 and 16:9 separately” vs shared-plate sentence | `index.tsx:738-756` | **DOES NOT COVER** |
| Advanced accordion | `index.tsx:767-801` | **COVERS** open + image-chip multi-select (J2) |
| FormatCard body / image+video chips | `index.tsx:859-983` | **COVERS** two live image chips; video chips **DOES NOT COVER** |
| `coming_soon` not selectable | `index.tsx:871-872, 928` | **COVERS** (J2 Demand Gen / Coming soon) |
| Derive-only PMax square: “Needs 9:16” / “Free crop of …” ; click toggles master | `index.tsx:879-882, 909-918, 961-983` | **COVERS** (J2) |
| Fallback catalog note | `index.tsx:804-809` | **VISITS** as J2 `catalogFellBack` env branch |
| Catalog prune of stale ticks | `index.tsx:1246-1268` | **DOES NOT COVER** |

`page-inventory.json:433` still says a second Meta video tick **replaces** the first. **That is stale.** `toggleVideo` is independent multi-select for Meta too (`index.tsx:448-468`). Billing clamp is `clampBillableVideo` (`233-237`) + `countDistinctVideoPlates` (`273-275`).

### VideoControlsStrip (only if `adKinds` includes video)

`index.tsx:1414-1418, 1631-1808`

| Element | Coverage |
|---|---|
| Video length 4/6/8/10/12/15s | **DOES NOT COVER** |
| “AI director variants” Switch (hidden for brand-kind) | **DOES NOT COVER** |
| “Video prompt guidance” textarea + 1000 cap | **DOES NOT COVER** |
| “Advanced — raw prompt” + “Load canonical scaffold” | **DOES NOT COVER** (and `Derive now`/`Refresh` are denylisted in journeys) |

J2’s Meta All-video click **would mount** this strip; nothing asserts it.

### ExpressGenerateBar (orange; only if a preset is fully on and step ≠ generate)

`index.tsx:1407-1411, 1461-1563`. Button “Quick generate — use defaults”. Journeys **denylist** it (`journeys.js:43`). Presence: **DOES NOT COVER** (lint list only). Click: correctly forbidden on free tier.

### Step 1 — campaign

`Step1Campaign.tsx`

| State / control | Source | Coverage |
|---|---|---|
| Loading “Loading campaigns…” | `67-72` | J3 **waits through**; does not assert |
| Error card | `75-80` | **DOES NOT COVER** |
| Empty: “No campaigns connected” + Connect / + New campaign / Upload media | `83-115` | J5 **COVERS** empty + New campaign opens + Cancel. Last run **SKIPPED** (no empty brand). Connect/Upload: **DOES NOT COVER** |
| Radio list + platform/status/Expired/objective badges | `118-187` | J3 **COVERS** “click first radio → Next enables”. Expired still selectable: **DOES NOT COVER** |
| “+ New campaign” on the **list** (not empty) | `130-135` | **DOES NOT COVER** |

`campaignKind` is **not** set on Step 1. The list payload includes `kind` (`liquidretail_backend/routes/campaigns.js:144`) but Step 1’s `Campaign` type omits it (`Step1Campaign.tsx:28-39`). Kind is hydrated in Step 2 from `GET /api/campaigns/:id` (`Step2Picker.tsx:403-453`). Until that returns, `canProceed` on products treats the campaign as **not** brand.

### Step 2 — products / media

`Step2Picker.tsx` + `RibbonPicker.tsx`

Three layouts: brand-kind (`BrandUnifiedView`), product-kind (`ProductKindView`), else the old two-ribbon layout (`1407-1568`).

| Element / state | Source | Coverage |
|---|---|---|
| Headings: “Pick products to make ads for” / “Making ads for N” / “Pick media…” / “Pick products + media” | `1286-1299` | J3 **VISITS** via `waitForAny`. Does not assert which layout |
| Selected chips + per-chip remove + “Clear all” | `1306-1358` | **DOES NOT COVER** |
| Search `aria-label="Search products"` + debounce | `1369-1376, 280-283` | **DOES NOT COVER** |
| “Showing N of M” / “Load N more” | `1378-1395` | **DOES NOT COVER** |
| Prepare catalog banner / “Prepare catalog images” | `2187-2327` | **DOES NOT COVER** |
| ProductTile 160px; unusable: `disabled`, click no-op | `RibbonPicker.tsx:202-218` | **DOES NOT COVER**. Heuristic **never reaches** these (Gap 1) |
| PREPARING badge still selectable | `RibbonPicker.tsx:167-176, 200` | **DOES NOT COVER** |
| MediaTile **120px** | `RibbonPicker.tsx:309` | **DOES NOT COVER** (heuristic is 140–200px, so media is invisible to J3) |
| Product-kind related media + ▶ video-seed badge | `2415-2492` | **DOES NOT COVER** |
| “Add same-category posts” / “Add brand-only posts” / “Show promotional posts” | `2501-2533` | **DOES NOT COVER** |
| Brand-kind unified ribbon + “Queued for this run” | `2832-1866` | **DOES NOT COVER** |
| Catalog images / “Video seeds — ordered” / “Image-ad queue” | `1574-1933` | **DOES NOT COVER** |
| Exclude pairing ✕ (`aria-label`) | `2023-2041` | **DOES NOT COVER** |
| Promo banner | `2109-2168` | **DOES NOT COVER** |
| Empty: “No products in this brand's catalog yet.” | product-kind `2409`; other `1469` | **DOES NOT COVER** (J3 skips if no tiles **after** the bad click; last run did not skip — it thought it clicked a tile) |
| Image-queue auto-pick into `mediaIds` (enables Next as a side effect) | `1070-1102` | **DOES NOT COVER** |
| Deep-link skips campaign pins | `438-445` | **DOES NOT COVER** |

`pages.js` for `?step=products` asserts **other-kind** copy (“Pick products + media”, “Click to feature in generated ads”). A deep-link with `campaignKind === null` renders that fallback. That is **not** the product-kind operator path.

### Step 4 — review / Generate

`Step4Generate.tsx` + `WizardBriefEditor.tsx`

| Element / state | Source | Coverage |
|---|---|---|
| “Review & generate” | `423` | J4 **intends**; last run never arrived |
| Brief: loading / empty / Edit / Derive now / Refresh / Save / Cancel / expand | `WizardBriefEditor.tsx:127-180` | **DOES NOT COVER**. Journeys **forbid** Derive now / Refresh |
| Campaign / Products / Media summary; cap 8 thumbs | `428-458, 91` | **DOES NOT COVER** |
| Output `{n} creative(s)` + “backend dry-run pending” | `461-475` | J4 **intends** after a format tick |
| Orange `formatBillableSummary` badge | `737-756, 483-496` | **DOES NOT COVER** on free tier. gui1 **COVERS** vs `/api/ads/preview` **if** it reaches Step 4 (it uses the same broken tile click) |
| Generate Ads disabled: no format | `179-180, 513` | J4 **COVERS** this (the “no pre-tick default” check at `journeys.js:1386-1394`) — **never ran** last time |
| Generate Ads disabled: `seedCount===0` | `531-535` | **DOES NOT COVER** (brand-kind zero-pick path) |
| “Account setup incomplete” | `520-529` | J4 **skip** if seen, not a pass |
| Duplicate modal + “Generate anyway” | `544-588` | Free tier denylists the confirm. gui1 **skips** if the dialog appears |
| Success navigates to **`/ads?campaignRunId=`** (legacy Ads page) | `392-396` | Out of this area; noted because “delivered” lives there |

`pages.js` `/generate-ads?step=generate` has **`selectors: []`** (`pages.js:377-380`). That is a visit with nothing that can fail.

---

## 2. Observed failures vs the real gate / the real arithmetic

### Gap 1 (highest) — “Next: Generate stayed disabled after a tile was selected”

**VERIFIED last run** (`ui-smoke/artifacts/results.json:80-85`):

```
tile=ACTIVE BRAND  state={"text":"Next: Generate","disabled":true}
```

**What `canProceed` actually requires** (`index.tsx:1348-1351`): a product id, a media id, or `campaignKind === 'brand'`. Clicking the sidebar brand picker writes none of those.

**Why the harness thought it selected a product** — `selectFirstPickerTile` (`journeys.js:455-468`) clicks the first `button` with width **140–200px** and no `✓`.

| Candidate | Width | In band? |
|---|---|---|
| BrandPicker `MenuButton w="full"` | Sidebar `w="240px"` + `px={5}` (`shell/Sidebar.tsx:29,37`) → content **≈200px** | **Yes** (`<= 200` is inclusive) |
| ProductTile | `w="160px"` (`RibbonPicker.tsx:207`) | Yes, but **later in the DOM** |
| MediaTile | `w="120px"` (`RibbonPicker.tsx:309`) | **No** |

BrandPicker’s first innerText line is `"Active brand"` with `textTransform="uppercase"` (`shell/BrandPicker.tsx:86-88`) → rendered `"ACTIVE BRAND"`. That is an exact match to the failure payload.

J4 failed for the same reason (`results.json:108-111`: “could not click Next off the products step”). gui1 (`generation-ui.js:235-250`) copies the same heuristic.

**INFERENCE:** this is a **harness defect**, not a wizard-gate defect. An operator clicking a 160px product tile would enable Next. The suite never did that, so **the real Step 2 gate is uncovered**.

Secondary real-product risks the suite also cannot see:

- Unusable ProductTiles are `disabled` and ignore click (`RibbonPicker.tsx:202-218`). An operator (or a fixed harness) clicking a `NO PHOTO` / `BROKEN IMAGE` tile would also leave Next disabled — **owner-visible, currently untested**.
- Brand-kind can enable Next with **zero** picks (`index.tsx:1345-1351`) while Step 4 still requires `seedCount > 0` (`Step4Generate.tsx:176, 513, 531-535`). That is a dead-end the suite would treat as success at J3.

**Stable hook:** **none**. No `data-testid` anywhere under `GenerateAds/` except `aria-label="Search products"` (`Step2Picker.tsx:1376`) and pairing exclude (`2038`). ProductTile has `aria-pressed` only (`RibbonPicker.tsx:219`).

### Gap 2 — UI quoted 2 video generations; test expected 3

**VERIFIED last run** (`results.json:54-59`): J2 label `video generations per product after Meta + PMax All video`, expected `3 ± 0`, actual `2`.

The test **adds** the two badges (`journeys.js:960-968`):

```javascript
const expectedVideo = 1 + (both.pmaxVideo.masterCount || 0);
```

Meta All-video badge is clamped to **1** (`clampBillableVideo` at `index.tsx:233-237, 689-693`). PMax All-video badge is **uncamped key count**, typically **2** (9:16 + 16:9; derive-only 1:1 excluded by `liveFormatKeys` at `125-138`). Sum = **3**.

The spend line does **not** sum. It uses `countDistinctVideoPlates` (`index.tsx:541-549, 721-724`). `videoPlateId` maps **both** `meta_stories_9_16` and `pmax_video_9_16` to `'shared_9_16'` (`260-264`). Mixed Meta+PMax video = **2** plates (shared 9:16 + PMax 16:9). The Everything badge uses the same helper (`529, 639`).

Backend minting **can** share: `planDeterministicVideoAds` marks `pmax_video_9_16` `billable: false` when unified (`campaignAdsGenerationService.js:718-739`). Sharing is **conditional** (`resolvePortraitMasterFormat` `659-685`: kill switch, prompt coherence, Meta duration floor ≥ PMax 10s). The picker comment says the UI is a **best-effort default**, and `/api/ads/preview` is the real quote (`index.tsx:253-259`). **J2 never calls preview.**

| Layer | Mixed Meta+PMax All video |
|---|---|
| Per-platform badges | 1 + 2 = 3 |
| Spend line / Everything badge | **2** (always share) |
| Backend preview | **2 if conjuncts pass, 3 if any fails** |
| J2 expected | **3** |

**INFERENCE:** the red J2 is a **stale test vs PR #218 sharing**, not a picker that “forgot” a master. The **silent money risk** is the other direction: if a backend conjunct refuses sharing, the spend line still says 2 and the operator is billed 3. That is exactly the `apiJson` / “display estimate ≠ preview” class.

---

## 3. Ranked gaps (owner-visible × silent)

| Rank | Gap | Reaches owner? | Silent? | Coverage today |
|---|---|---|---|---|
| 1 | Step 2 Next never actually enabled by a product click (harness hits BrandPicker) | Yes — J3/J4 are red every run, so the owner is told the wizard is broken | Test is loud; **product gate is untested**. Unusable-tile no-op would be silent (disabled button, no error) | Intended COVERS, actually **DOES NOT COVER** |
| 2 | Mixed-video spend: UI 2 vs test 3 vs backend maybe 2 or 3 | Yes — spend line is on every step | **Yes if UI under-quotes vs preview.** `apiJson` will not throw | J2 **COVERS the wrong formula**. Preview cross-check **DOES NOT COVER** |
| 3 | Step 4 Generate gating (`noFormatSelected`, `seedCount===0`, readiness) | Yes — button just sits disabled | `noFormatSelected` is explained by the picker line. `seedCount===0` after a brand-kind Next is easy to miss. Readiness is a tooltip | J4 written, **never reached**. gui1 same tile bug |
| 4 | Everything capstone never clicked | Yes — one-click “buy all” is the express path | Arithmetic bug here is the same shared-plate class | **VISITS** only |
| 5 | Format catalog has **no** `derivesFrom`; `VIDEO_DERIVE_ONLY` / `VIDEO_DERIVE_MASTER` are hardcoded (`index.tsx:79-103`) | Yes if a new derive-only surface becomes a billable chip | **Yes** — extra Omni submit, no client error | J2 covers **today’s** PMax square only |
| 6 | Step 2 rails (search, load more, unusable tiles, video seeds, image queue, exclude, prepare catalog, brand-kind, promo) | Yes | Image-queue auto-`mediaIds` is a known silent backend-override (`Step2Picker.tsx:923-936`); untested | **DOES NOT COVER** |
| 7 | VideoControlsStrip + ExpressGenerateBar | Yes | Raw prompt bypasses safeguards (`index.tsx:1770`) | **DOES NOT COVER** (express correctly denylisted) |
| 8 | WizardBriefEditor + 409 “Generate anyway” | Yes | “Generate anyway” is a second bill (`Step4Generate.tsx:562-566`) | Denylisted; **DOES NOT COVER** |
| 9 | Step 1 error / expired / list “+ New campaign” / J5 empty brand | Yes | Expired still generates (copy says so) | J5 **SKIPPED** last run |
| 10 | `pages.js` “Media” on `/generate-ads` | No | Vacuous pass (below) | **VISITS**, cannot fail |

---

## 4. Assertion sketches (selector-lint-legal)

`selector-lint.js` only proves a **literal exists in `origin/master` source** (`harness/selector-lint.js:111-147`). Runtime-assembled strings need `{ dynamic: true }`. `"Next: Generate"` is **not** a contiguous literal — the source is `` `Next: ${displayedSteps[...].label}` `` (`index.tsx:1437`). Lint list already uses `'Next:'` (`journeys.js:555`).

### A. Step 2 Next — replace the width heuristic

**No stable hook on ProductTile.** Flag: add `data-testid="wizard-product-tile"` (and `wizard-next`) before this can be a lint-clean CSS selector. Until then, evaluate — do not click width∈[140,200].

Sketch (literals that **do** exist today):

```js
// pages[].selectors
'Pick products to make ads for',          // Step2Picker.tsx:1291
'Next:',                                  // index.tsx:1437
{ text: 'Next: Generate', dynamic: true },
{ text: 'ACTIVE BRAND', dynamic: true }   // must NOT be the click target

// runtime
const tile = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('button[aria-pressed]')]
    .filter(b => b.getBoundingClientRect().width === 160)
    .filter(b => !b.disabled)
    .filter(b => !/active brand/i.test(b.innerText));
  const t = tiles.find(b => b.getAttribute('aria-pressed') !== 'true') || null;
  if (!t) return { ok: false };
  t.click();
  return { ok: true, title: t.innerText.split('\n')[0] };
});
// then: button starting with "Next:" has disabled === false
```

Also assert the **negative**: after clicking a `button[disabled][aria-disabled]` whose text includes `NO PHOTO` / `BROKEN IMAGE` (`RibbonPicker.tsx:158-164, 232-239`), Next stays disabled. Those badge strings exist in source.

### B. Mixed-video spend — stop summing badges

Do **not** `1 + pmaxVideo.masterCount`. Compare three numbers that are supposed to be the same plate count:

```js
// literals
'video generation', 'per product',        // index.tsx:723-724
'Everything (Meta + PMax)',               // index.tsx:635
{ text: 'N video generations per product', dynamic: true }

// runtime after Meta All video + PMax All video
spend.videos === presets.everything.masterCount
// AND (free) POST /api/ads/preview with the wizard’s actual
// staticFormats/videoFormats, then:
preview.billable.videoMasters / productCount === spend.videos
```

If preview is 3 and the spend line is 2, that is a **product** defect (UI under-quote). If both are 2, J2’s `3` is a **test** defect.

### C. Everything click

```js
'Everything (Meta + PMax)'  // index.tsx:635 — lint-ok
// click it from empty; spend.images === everything.sizeCount
// spend.videos === everything.masterCount
```

### D. Step 4 Generate disabled with no format (already written; blocked by Gap 1)

Keep J4’s `Generate is enabled before any format was ticked` check (`journeys.js:1386-1394`). Literal: `'Generate Ads'` (`Step4Generate.tsx:515`), `'Pick at least one size. Nothing is selected, so Generate has nothing to render.'` (`index.tsx:713`).

---

## 5. Vacuous assertions (cannot fail on a healthy page, or cannot fail the thing they name)

| Assertion | Why it cannot fail / does not test |
|---|---|
| `pages.js` `/generate-ads` selector `"Media"` (`pages.js:331`) | `hasText` is a **substring** match (`harness/runner.js:263-267`). Sidebar always contains **“Media Library”** (`routes.ts:50`). Passes even if the wizard body is blank. |
| `pages.js` `/generate-ads?step=generate` `selectors: []` (`pages.js:380`) | Empty list. Visit only. Cannot fail on review UI. |
| `pages.js` `"Meta"` (`pages.js:333`) | Always in the picker heading (`index.tsx:184`). Does not prove a preset works. |
| `pages.js` `"Products"` on `?step=products` | Stepper always says “Products” unless brand-kind (`index.tsx:1146`). Does not prove a tile was selected. |
| J2 `expectText('Meta')` / `'PMax'` / `'All static'` | Presence, already implied by `readPresets`. The **failing** check is the later `expectWithin`; these would stay green on a 2-vs-3 bug. |
| J2 video block wrapped in `if (metaVidClick.ok)` (`journeys.js:924-973`) | If Meta All video is not clickable, **the 2-vs-3 check is skipped** and J2 can still pass later Advanced checks. Last run did enter the block (it failed), so this is a latent hole, not the current red. |
| `void comboTested` (`journeys.js:913`) | Combinability **does** `fail` on wipe (`887-896`). The unused flag is not itself an assertion. |
| journeys `pages[]` `'Next:'` | Lint-only. Does not assert enabled/disabled. |
| J3 `expectNoConsoleErrors` | Would have run only after Next enabled. Last run died earlier. Console-clean is not “Next works.” |

**Not vacuous (they can and did fail):** J2 `expectWithin(..., 3, 0)` — it failed, but the **expected value is wrong** relative to `countDistinctVideoPlates`. J3 “Next stayed disabled after selecting a product/media tile” — it failed, but the **click target was not a product**.

---

## What the last run actually proved

| Journey | Result | What it proved |
|---|---|---|
| J1 Product Ads → wizard | pass | Row “Generate Ads” lands on `?step=campaign`; picker heading renders |
| J2 format picker | **fail** 2≠3 | Presets, Clear, Advanced multi-select, coming_soon, PMax square **did run**. Mixed-video **count formula is wrong** |
| J3 Step 2 | **fail** | Clicked sidebar **Active brand**. Did **not** exercise `canProceed` |
| J4 review | **fail** | Never left products |
| J5 empty merchant | skip | No empty brand in the workspace |
| `pages.js` `/generate-ads` | visit | Chrome strings; `"Media"` is vacuous |
| gui1 / `generation.js` | not in this $0 run | Would share J3’s tile bug before any spend |

**Bottom line:** the two owner-reported failures are real suite reds. The Next failure is the harness clicking the 200px brand picker (`Sidebar.tsx:29,37` + `BrandPicker.tsx:82-88`) instead of a 160px `ProductTile`. The 2-vs-3 failure is J2 summing per-platform badges after the picker started deduping the shared 9:16 plate (`index.tsx:260-275, 541-549`). Until J3 clicks a real product tile, Step 2 gating, Step 4 Generate, and the billable UI path are uncovered.
