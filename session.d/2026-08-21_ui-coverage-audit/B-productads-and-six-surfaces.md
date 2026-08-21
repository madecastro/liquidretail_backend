I'll read the real ProductAds code, every surface that imports it, and the harness coverage — no file edits and no subagents. Starting with session state, the shared components, and the adapter mappers.Grok CLI local is available, but this pass stays in-process: I’ll query CodeGraph and read the real files so the report is one coherent document.CodeGraph is down, so I’m reading the shared components, each adapter mapper, and the harness suites directly.Next I’ll read AdDetailModal, AdThumbnail, the status-badge path, and the backend/agent projections that feed them.The ads-detail `$project` includes `renderStage`, but the mapper may drop it — I’ll verify that against `/api/ads` and the inspector fields next.# ProductAds + shared AdThumbnail / AdDetailModal — coverage audit

**Scope:** `frontend/app/src/pages/ProductAds/index.tsx` (defines `AdThumbnail`, `AdDetailModal`, `AdSectionGrid`) and every consumer. No files edited. CodeGraph was unavailable (`unable to open database file`); claims below are from the live source.

**Six surfaces (verified imports):**

| Surface | What it imports | Adapter |
|---|---|---|
| ProductAds (primary `/product-ads`) | defines both | none — consumes catalog `ads-detail` as `ExpansionAd` |
| UgcAds | `AdThumbnail`, `AdDetailModal` | `toExpansionAd` |
| CampaignDetail | `AdThumbnail`, `AdDetailModal` | `adRowToExpansionAd` |
| Campaigns | `AdSectionGrid`, `AdDetailModal`, `sectionFor` | **none** — types ads-detail rows as `ExpansionAd[]` |
| `agent/ResourceCard` (`/home`) | `AdThumbnail`, `AdDetailModal` | `adListEntryToExpansionAd` |
| `GenerationInspectorModal` | **does not import them** | opened *from* `AdDetailModal` (`ProductAds/index.tsx:1630-1632`) |

`pages/Ads/index.tsx` is legacy (do-not-develop). Out of scope except where it is the *only* place an owner requirement actually exists (CTA URL, default status filter).

`apiJson<T>` is an unchecked cast (`auth/apiFetch.ts:114-126`). A missing field is `undefined` and paints blank with no error.

---

## VERIFIED — mapper / projection omissions (the 6× silent path)

A prior pass claimed the `/home` ResourceCard path has an agent `.select` that omits a field. **True, and it is not unique.** `renderStage` / `renderStageAt` are dropped on **every** shared-tile path. The `$project` / `.select` allowlist including a field is not enough: several mappers then omit it from the JSON the SPA actually receives.

### 1. Agent `ad.list` `.select` omits `renderStage` / `renderStageAt`

```57:66:liquidretail_backend/services/capabilityExecutors/adList.js
    Ad.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('_id kind template aspectRatio platformFormat status renderUrl posterUrl copy ctaText productId campaignId createdAt updatedAt renderedAt metaSyncStatus metaAdId metaAdsetId variantKind mediaId sourceFileType approved approvedAt regenerating regenerationStage regenerationHistory aiCanvasArtifactId')
```

`photorealUrl` is joined after the query (`adList.js:73-76`) — that one is fine. **`renderStage` and `renderStageAt` are not selected and not joined.**

The frontend adapter also never copies them (`ResourceCard.tsx:114-143`). Even if the select grew, the adapter would still drop them.

### 2. Sibling: catalog `ads-detail` `$project` includes the fields; the mapper drops them

`$project` names them (`catalog.js:723-736`) with an explicit comment that Product Ads used to show a bare “Queued”. The **response mapper does not copy them** (`catalog.js:794-843`). Keys present: `adId` … `sourceMedia`. **Absent: `renderStage`, `renderStageAt`.** Product Ads therefore still receives `undefined` for both.

### 3. Sibling: campaigns `ads-detail` — same mapper drop, plus two more

`$project` includes `renderStage`, `renderStageAt`, `variantKind`, `mediaId` (`campaigns.js:404-413`). The mapper (`campaigns.js:449-488`) copies **none of those four**. Campaigns types the payload as `ExpansionAd[]` with no adapter (`Campaigns/index.tsx:52-55`, `:759-824`), so UGC badges never appear on `/campaigns` expansions (`AdThumbnail` only badges `variantKind === 'ugc' && mediaId`, `ProductAds/index.tsx:2145-2147`).

### 4. Sibling: GET `/api/ads` `projectAd` *has* the fields; UgcAds + CampaignDetail adapters drop them

`projectAd` emits `renderStage` / `renderStageAt` (`routes/ads.js:4497-4503`). Both adapters omit them:

- `toExpansionAd` — `UgcAds/index.tsx:131-160`
- `adRowToExpansionAd` — `CampaignDetail/index.tsx:1053-1082`

### What the owner sees (silent)

`AdThumbnail` calls `resolveAdStatusBadge(ad.status, ad.kind, ad.renderStage ?? null, ad.renderStageAt)` (`ProductAds/index.tsx:2130-2135`). With `renderStage` missing:

- Empty stage → `{ label: status, inProgress: false, tone: idle|live|warn }` (`Ads/index.tsx:350-358`).
- Overlay badge only renders when `inProgress || tone === 'warn'` (`ProductAds/index.tsx:2205`). A **draft-with-renderUrl that is still titling** looks finished.
- Footer paints **`Draft`** / **`Live`** from raw `ad.status` (`ProductAds/index.tsx:2232-2233`).

`verifyStageVisibility.js` B1 only regexes `$project` bodies (`scripts/verifyStageVisibility.js:103-126`). It **cannot fail** this mapper-drop. That is a vacuous backend gate for this bug class.

### Other adapter holes (same silent class)

| Field owner cares about | catalog mapper | campaigns mapper | Ugc/CampaignDetail adapters | ad.list |
|---|---|---|---|---|
| `renderStage` / `renderStageAt` | dropped after `$project` | dropped after `$project` | dropped | not selected |
| `variantKind` / `mediaId` | present | dropped after `$project` | present | present |
| `sourceMedia` (UGC hover) | present | never joined | hardcoded `null` | hardcoded `null` |
| `ctaUrl` (retailer URL) | not mapped | not mapped | not on `ExpansionAd` | not selected |
| `intentResolution` | not mapped | not mapped | not mapped | not selected |

`ad.inspect` (the `/home` inspect card, **not** `AdThumbnail`) reads `ad.imageGeneration?.intentResolution` (`adInspect.js:85`). The inspector endpoint reads `ad.intentResolution` (`ads.js:4328`). Those are different documents. Inspect can show a blank intent while the modal inspector has one.

---

## VERIFIED — default status filter / delivered ads

**Product Ads has no status dropdown.** Mount fetch is `GET /api/catalog/ads-summary` (`ProductAds/index.tsx:285-301`). Expansion is `GET /api/catalog/:id/ads-detail` with `status: { $ne: 'archived' }` (`catalog.js:704-708`). **`status:draft` is included.** Freshly delivered ads (`draft` + `renderUrl`) are in the Draft section (`sectionFor`, `ProductAds/index.tsx:184-188`).

Same for Campaigns ads-detail (`campaigns.js:400`).

CampaignDetail + UgcAds use `rendered=true`:

```3240:3246:liquidretail_backend/routes/ads.js
    if (req.query.rendered === 'true' && !req.query.status) {
      filter.status = { $in: ['draft', 'live', 'archived'] };
    }
```

(`CampaignDetail/index.tsx:216`, `UgcAds/index.tsx:550`.) Delivered ads **are** included. **Queued / rendering / failed are hidden** on those two surfaces.

Agent `ad.list`: no default status (`adList.js:43, 51-53`). Window is **last 24h by `createdAt`**, not recency (`adList.js:51`). A delivered ad older than 24h is invisible in chat; a re-rendered old row is also invisible.

Out of scope but the only real “status filter on mount”: legacy `/ads` defaults to `'draft'` (`Ads/index.tsx:543`, comment at `:10`). That *does* include delivered ads. It hides `live` / in-flight unless the operator changes the select.

**INFERENCE:** Product Ads will not hide a fresh delivery behind a status filter. The visibility bug is the **pill copy** (`Draft` instead of `Ready for Review`) and **missing `renderStage`**, not the filter.

---

## VERIFIED — status pill vs “Ready for Review”

Grep of `liquidretail/` for `Ready for Review`: **zero hits**. A handoff file claims FE #67 delivered it; **current master/trunk source does not**.

What the owner actually sees on all five tile surfaces:

- In-flight overlay: `resolveAdStatusBadge` label (pipeline words) — **but only if `renderStage` arrives**, which it currently does not on these paths.
- Resting footer: literal **`Draft`** or **`Live`** (`ProductAds/index.tsx:2232-2233`).
- Modal header: **`Exported` / `Approved` / `Draft`** from `metaSyncStatus` / `approved`, not from pipeline state (`ProductAds/index.tsx:1116-1118`).

So a finished, unapproved ad reads **“Draft”** in the tile footer and **“Draft”** in the modal chrome. That is the opposite of the owner requirement.

---

## VERIFIED — click-into-ad: intent, media type, surface, retailer URL

Owner: clicking an ad must show intent profile, media type, surface details, and retailer URL.

**AdDetailModal header** (`ProductAds/index.tsx:1112-1128`): headline/template, Exported/Approved/Draft, `template`, `aspectRatio`, `platformFormat` (underscores → spaces), **`ad.kind`**, `adId` + Copy.

| Required | On AdDetailModal (all 5 openers)? | On GenerationInspectorModal? |
|---|---|---|
| Media type | **Partial** — raw `ad.kind` (`image`/`video`) | kind is in the payload type, not shown as a labelled row |
| Surface | **Partial** — `platformFormat` string | not labelled as surface; `intentResolution.surface` is in the type (`GenerationInspectorModal.tsx:62-66`) and **never rendered** |
| Intent profile | **No** | **Conditional, image-only:** block `{data.image.intentResolution && (` at `:476`. Shows `delivered`, `fellBackFrom`, gen size, logo, dropped roles. Does **not** show `requested` or `surface`. Video ads have no intent block. Missing field → section omitted, no error. |
| Retailer URL | **No.** `ExpansionAd` has no `ctaUrl`. | **No.** Inspector payload has no `ctaUrl` / `productUrl`. |

Legacy `/ads` detail **does** show `CTA URL` (`Ads/index.tsx:1589`). That is the trap the handoff warned about: the requirement was built on the page the owner does not use.

Inspector is a second click (`Generation details`, `ProductAds/index.tsx:1580-1582`). Even then, intent is gated and image-only.

---

## 1. Interactive elements + states, with harness coverage

Coverage key: **COVERS** = asserts that control/state. **VISITS** = loads the route / asserts always-on chrome. **NONE** = not exercised. “No console error” is not coverage.

### A. `/product-ads` page chrome — `ProductAdsPage`

| Element / state | Source | Harness |
|---|---|---|
| PageHeader title/description | `:364, :372` | **VISITS** — `pages.js:146-152` and `journeys.js` j1 assert these strings |
| No brand: “Select a brand to continue.” | `:361-367` | **VISITS** — j1 classifies then **skips** (`journeys.js:702-704`). pages.js does not wait for it |
| Loading: “Loading products…” | `:442-444` | **NONE** as a state. j1 waits for it to **go away** (`:681`) |
| Error: `{err}` | `:445-447` | **NONE** |
| Empty: “No products yet” + Connect catalog + Browse catalog | `:448-465` | **VISITS** — j1 **skips** if empty (`:705-707`). pages.js lists the string in inventory, not as a pages.js selector |
| KPI tiles Ad Coverage / Good Opportunities / Ads Created / Ready to Export | `:375-398` | **VISITS / vacuous** — labels render on first paint with `—` (`:378`). j1 documents this trap (`journeys.js:669-680`) and then still `expectText`s the labels after settle. pages.js asserts the labels with **no settle wait** |
| Good Opportunities tooltip “Phase 2 — opportunity scoring engine” | `:386` | **NONE** (title attr, not innerText) |
| Category `<Select>` | `:401-420`, only if `categories.length > 0` | **NONE** |
| Bulk bar: N selected / Generate Ads / Clear | `:423-438` | **NONE** — never ticks a checkbox |
| Header checkbox (select all) | `:484` | **NONE** |
| Table headers Product / Ad Coverage / … | `:485-490` | **NONE** |
| Per-row checkbox | `:1690` | **NONE** |
| Per-row click → expand | `:1688, :329` | **NONE** |
| Campaign chip `Link` to `/campaigns/:id` | `:1717-1732` | **NONE** |
| Per-row “Generate Ads” | `:1765-1767` | **COVERS (navigation only)** — j1 and `generation-ui` click it to leave the page (`journeys.js:715+`, `generation-ui.js:193`). They never expand, never open a tile |
| Brand switch re-scope | mount effect `:285` | **COVERS** j7 (`journeys.js:1728-1818`) — KPI signature only |

### B. Product-row expansion (`ProductRowView` / `ExpansionPanel` / `AdSectionGrid`)

| Element / state | Source | Harness |
|---|---|---|
| Expansion loading “Loading campaigns + ads…” | `:1774-1778` | **NONE** |
| Expansion fetch error (toast only; panel goes blank) | `:339-345` then `:1780` requires `expansion` | **NONE** — failed load looks like an empty expand. Silent |
| Empty product “No ads generated for this product yet.” | `:1848-1853` | **NONE** |
| Fetch-ceiling note (60 ads) | `:1868-1871`, `PRODUCT_ADS_FETCH_LIMIT=60` | **NONE** |
| Campaign sidebar “All Campaigns” + per-campaign rows | `:1873-1889` | **NONE** |
| Variant chips All / Product shots / UGC ads | `:1896-1899` | **NONE** |
| Filtered empty “No ads in this campaign yet.” | `:1901-1903` | **NONE** |
| Sections Draft / Approved / Exported (hide if empty) | `:1904-1921`, `:1949` | **NONE** |
| Tile click → `onOpenAd` | `:1964` | **NONE** |
| “View all {n} {label} ads” after 20 | `:1969-1977`, `AD_SECTION_INITIAL=20` | **NONE** |

page-inventory still says the cap is 12 with no view-more (`page-inventory.json:190`). **Stale.** Code is 20 + disclosure (`ProductAds/index.tsx:1938-1977`). pages.js copies the stale 12 in `edgeCases` (`pages.js:165`).

### C. `AdThumbnail` (shared ×5)

| Element / state | Source | Harness |
|---|---|---|
| Chrome preview + image / `HoverPlayVideo` | `:2158-2181` | **NONE** on any of the five surfaces |
| Empty tile: Queued / Rendering… / Render failed / No render / in-progress label | `:2182-2196` | **NONE** |
| In-progress / warn overlay badge | `:2205-2225` | **NONE** — and currently dead for these surfaces because `renderStage` is missing |
| Footer platformFormat / Draft / Live | `:2227-2234` | **NONE** |
| UGC pill → `/ugc-ads?mediaId=` + hover preview | `:2027-2098, :2145` | **NONE**. Only Product Ads can populate `sourceMedia` |

**No `data-testid`, no `aria-label`** in ProductAds or ResourceCard. Tile click target is an unlabelled `Box` (`:1964, :171, :1157, :854`).

### D. `AdDetailModal` (shared ×5)

Opened from ProductAds, UgcAds, CampaignDetail, Campaigns, ResourceCard `AdListCard`. **Never opened by the harness on any of those routes.**

j6 opens a **different** modal on legacy `/ads` (`journeys.js:1608-1724`). It waits for `Template` / `Aspect ratio` / `Ad detail` / `Title copy`. “Title copy” exists in ProductAds (`:1187`); “Ad detail” / labelled “Template” / “Aspect ratio” rows are the **legacy** modal (`Ads/index.tsx:1584-1586`). j6 is not coverage of `AdDetailModal`.

| Element / state | Source | Harness |
|---|---|---|
| Header badges Exported / Approved / Draft | `:1116-1118` | **NONE** |
| Copy ad id | `:1129-1137` | **NONE** |
| Preview chrome + `ChromeSelect` “Preview as” | `:1145-1173` | **NONE** |
| “No render available” | `:1175-1179` | **NONE** |
| Title copy Headline / CTA inputs | `:1186-1213` | **NONE** |
| “Saved copy applies to future renders…” (image only) | `:1214-1218` | **NONE** |
| Save copy / Re-render title | `:1226-1256` | **NONE** (and harness policy forbids approve/export; copy-save is also untested) |
| Regen banner `stageLabel(...)` | `:1264-1273` | **NONE**. Poll is skipped if `!ad.campaignId` (`:713`) — silent stall |
| “Last regenerate failed” | `:1275-1279` | **NONE** |
| Regen panel, video re-roll checkbox, model select, Advanced canonical / image prompt | `:1285-1547` | **NONE** |
| AdSet picker / “No Meta AdSets found…” | `:1553-1574` | **NONE** |
| Close / Generation details / Regenerate / Approve|Unapprove / Export|Push to Meta|Synced to Meta | `:1577-1626` | **NONE** |
| Exported read-only (`title='Exported ads are read-only'`) | several | **NONE** |
| Loading/error toasts (copy, regen, approve, export, scaffold) | throughout | **NONE** |

### E. `GenerationInspectorModal` (opened from AdDetailModal + legacy Ads)

| Element / state | Source | Harness |
|---|---|---|
| Loading “Loading generation inputs…” | `:258-259` | **NONE** |
| `{error}` | `:260-261` | **NONE** |
| Warnings, seed, video, titling, static, intent, pipeline, timing, edit+regen | `:264-720` | **NONE** |
| Intent block (conditional) | `:476` | **NONE** |
| Close | `:726` | **NONE** |

### F. UgcAds extras around the shared tile

Filter chips, search, expand/collapse, Convert, “View all N ads”, empty “No UGC matches…”, loading/error: pages.js **VISITS** chip labels (`pages.js:174-181`). **No expand, no tile click, no modal.** No journey hits `/ugc-ads`.

`rendered=true` hides in-flight ads on this page (see above). **NONE.**

### G. Campaigns extras

KPI + filters + expand + `AdSectionGrid`: pages.js **VISITS** header strings (`pages.js:96-102`). j5 covers empty-state + New campaign modal, not expansion. **No row expand, no tile, no modal.**

Campaigns default `statusFilter` is `''` = All Statuses (`Campaigns/index.tsx:142`) — campaign status, not ad status.

### H. CampaignDetail extras

pages.js route `/campaigns/:id` is **SKIPPED** as a pattern (`run.js:236-241`). **NONE** for the Ads tab, `AdThumbnail`, unlink, empty “No ads generated for this campaign yet.” (`CampaignDetail/index.tsx:1130-1138`), “View all N” / fetch-ceiling (`:1084-1198`).

Selectors `"reach-social"`, `"Meta"`, `"Google"` (`pages.js:123-127`) would be wrong even if the skip were removed: `platformLabel('reach-social')` returns **`In-app`** (`CampaignDetail/index.tsx:835-839`). selector-lint would still pass because `'reach-social'` exists in source.

### I. `/home` ResourceCard

pages.js `/home` `selectors: []` (`pages.js:45`). **VISITS** the chat shell. `AdListCard` only renders after a successful `ad.list` tool result (`ResourceCard.tsx:41, :146-192`). **NONE.** `AdInspectCard` (`:275-304`) is a different, non-shared renderer (no `AdThumbnail`).

---

## 2. Gap ranking (owner-visible × silent)

1. **`renderStage` dropped on all five tile surfaces** — in-flight delivered-looking ads. Silent (`undefined` field). Reaches the owner on `/product-ads`, `/campaigns`, `/campaigns/:id`, `/ugc-ads`, `/home` chat. **Highest 6×.**
2. **Finished ads say `Draft`, not `Ready for Review`** — every tile + modal header. Reaches the owner constantly. Not silent in the untyped-field sense; it is wrong copy in source.
3. **Click-into-ad missing retailer URL + intent on the modal the owner actually opens.** Intent buried behind a second click, image-only, and omits `surface`/`requested`. `ctaUrl` exists on `projectAd` (`ads.js:4483`) and on the **legacy** modal only.
4. **Campaigns mapper also drops `variantKind`/`mediaId`** — UGC ads on `/campaigns` look like product shots. Silent.
5. **Expansion fetch failure → blank panel** (toast only). Owner can think the product has no ads.
6. **UgcAds / CampaignDetail `rendered=true` hides queued/rendering/failed.** In-flight work on those pages is invisible. Filter is explicit, not untyped — still owner-visible.
7. **Agent list 24h `createdAt` window** — “show my ads” misses older delivered work.
8. **AdSectionGrid / catalog `$limit: 60`** — extra ads exist but are truncated; there *is* a ceiling note (`:1868-1871`) on Product Ads only. Campaigns ads-detail `$limit: 120` with no equivalent note in `CampaignExpansionPanel`.
9. **Regen poll skipped without `campaignId`** (`:713`) — modal banner can stick on “Queued…” forever. Silent.
10. **`ad.inspect` intent from the wrong field** (`imageGeneration.intentResolution` vs `Ad.intentResolution`) — chat “why this ad” can disagree with the inspector.

---

## 3. Assertion sketches (selector-lint-legal)

Lint rule: literal must exist under `frontend/app/src` at `origin/master`, no trailing ellipsis, no `{placeholders}` (`selector-lint.js:123-137`).

### Top gap — expand + tile + resting pill (Product Ads, 6× if copied)

```js
// journeys.js — after waitGone('Loading products…') and a real coverage %
await clickNthProductRow(0); // NO STABLE HOOK — row is an HStack; use product title {dynamic:true}
await waitGone(run, 'Loading campaigns + ads…');
await checks.expectText('Campaigns');          // ExpansionPanel sidebar
await checks.expectText('Product shots');
await checks.expectText('UGC ads');
await checks.expectText('Draft');              // section label AND/OR tile footer — today this is the bug
// Desired after FE #67 actually lands:
// await checks.expectText('Ready for Review'); // WILL FAIL selector-lint TODAY (string absent)
```

**No stable hook:** product row, thumbnail `Box`, campaign sidebar row, variant chips. All are unlabelled `Box as="button"` or clickable `HStack`.

### Modal open + owner fields

```js
// click first img/video in the expansion (same pattern as j6, but AFTER expand on /product-ads)
await checks.expectText('Title copy');
await checks.expectText('Headline');
await checks.expectText('CTA');
await checks.expectText('Generation details');
await checks.expectText('Regenerate');
await checks.expectText('Approve'); // or Unapprove
// media type + surface are dynamic (ad.kind, platformFormat)
await checks.expectText({ text: 'image', dynamic: true }); // weak; kind is also in other chrome
```

Retailer URL has **no string to assert** on this modal. Adding `'CTA URL'` would be a **test defect** until the UI exists (legacy-only today). Flag: **no hook, no copy.**

### Inspector intent (second click)

```js
await clickText(run, 'Generation details');
await waitGone(run, 'Loading generation inputs…');
await checks.expectText('Intent resolution'); // exists in source; CONDITIONAL — skip if video / old ads
```

Do **not** assert `intentResolution.surface` — it is never rendered.

### `renderStage` live overlay (will fail today — that is the point)

After expand, while a row is titling, expect a pipeline word from `STAGE_RULES` (e.g. `'Titling'`, `'Generating image'`). Today the tile will show chrome + `Draft`. This is a **product fail**, not a selector-lint fail, if you pick a literal that exists in `Ads/index.tsx` (lint searches all of `src/`).

Copy the same expand→tile→modal journey onto `/campaigns`, `/ugc-ads`, `/campaigns/:id` (needs a real id fixture; the pages suite correctly skips the pattern), and `/home` after an `ad.list` turn. That is the 6×.

---

## 4. Existing assertions that cannot fail (vacuous)

| Assertion | Why it cannot fail |
|---|---|
| pages.js `/product-ads` selectors `Product Ads`, `Generate and manage ads for your products at scale.`, `Ad Coverage`, `Good Opportunities`, `Ads Created` (`pages.js:146-152`) | Header + KPI **labels** paint before the fetch. j1 itself calls `Ad Coverage` a static skeleton label (`journeys.js:669-676`). A hung or empty summary still shows them. pages.js does not wait out `Loading products…`. |
| pages.js `/home` `selectors: []` (`pages.js:45`) | Visit + console/network only. Chat empty-state copy is never asserted. `ResourceCard` is unreachable. |
| pages.js `/campaigns/:id` (`pages.js:120-127`) | **Always skipped** (`run.js:236-241`). Selectors never run. `"reach-social"` would not match rendered `In-app` anyway. |
| j1 `expectText` of the five KPI strings after settle (`journeys.js:709-713`) | Proves the page is still the Product Ads page, not that a tile, expansion, or modal works. |
| j6 (`journeys.js:1608`) | Covers **legacy `/ads`**, not `AdDetailModal`. A green j6 with a broken ProductAds modal is the exact 3× “built it on `/ads`” failure mode. |
| `verifyStageVisibility.js` B1 (`:103-126`) | Passes if `$project` names `renderStage`. The mapper can (and does) drop it. |
| page-inventory / pages.js edgeCase “caps at 12 with no view more” | Not executed; also **false** vs `AD_SECTION_INITIAL = 20`. |
| selector-lint on pages.js `/product-ads` | Confirms the KPI **words exist in source**, not that they mean data arrived. |

`expectNoConsoleErrors` / `expectNoFailedRequests` after pages.js selectors **can** fail (a 500 on ads-summary). They cannot fail a missing field, a wrong pill, or a modal that never opens.

---

## INFERENCE (not in source)

- FE #66 / #67 were claimed delivered in a handoff; they are not on this tree. Possible unmerged branch or revert — not verified against git history in this pass.
- Owner-visible “still rendering but looks done” is the predicted symptom of gap 1 on video ads that stamp `status:draft` before titling finishes (`ads.js:4487-4496` documents that stamp). I did not watch a live run.
- `/home` `AdListCard` is the only agent card that uses `AdThumbnail`. “Show me this ad” (`kind: 'ad'`) uses `AdInspectCard` and will not pick up a ProductAds pill/modal fix.

---

**Bottom line:** the harness **visits** `/product-ads` (and `/campaigns`, `/ugc-ads`) and **covers** “click Generate Ads to enter the wizard” plus brand re-scope. It does **not** expand a product, click a shared tile, open `AdDetailModal`, or open the inspector on any of the five real surfaces. The shared components are a 6× coverage hole sitting on top of a 6× silent `renderStage` drop and a pill that still says `Draft`.
