I'll run a hard adversarial review of the merged provenance / multi-ref fallback / stages / CostLog changes — reading the live code paths against your six hunt questions, not the narrative.Pulling the live call sites for the six hunt questions: video ref path, persistStage, adStage, render-activity auth, and CostLog `submitted` accounting.The live file may already differ from the prompt diff — re-reading the current `render-activity` handler and related paths.Checking one more adStage/reaper interaction and whether `recordFlatCost` for video omits fields that would break reports.## Adversarial review — provenance / multi-ref / stages / CostLog

Reviewed against current branch tip (`fc02aee`, includes the tenant fix) and the live call sites, not the narrative in the commit messages.

---

### 1. Video × `referenceMediaIds` fallback

**no findings**

`renderService` only threads the fallback into `renderStage` → `renderDirectImage` (static). `atlasVideoService` still reads `ad.referenceMediaIds` off the Ad document and never `mediaIds` / `referenceSource`. Concept video rows still get Director picks only in `mediaIds` and empty `referenceMediaIds` — same as before this change; video behaviour is unchanged.

---

### 2. Money: more refs / extra submits

**no findings** (no extra billable submit)

Fallback widens the **static** reference stack (Director 1–4 picks) on a single `editImage` call. Still one Atlas generation submit per ad. Image pricing path is flat model price, not per-ref. No second submit introduced.

**low | services/directImageRenderService.js:376–391 | unbounded mediaIds → larger/rejection-prone payload | why:** there is no `slice`/cap before upload+submit (Atlas edit docs say 1..10). Director is supposed to stay ≤4, but contract warnings do not truncate; a bloated `mediaIds` array is sent as-is. Speculative for money; real for fail-after-work if something else ever writes a huge list.

---

### 3. `persistStage` after Atlas billed

**no findings** (new fields do not add a throw surface)

`intentResolution` / `renderStages` are `Mixed`/`null`-safe plain objects. `undefined` becomes `null`. No enum validation. BSON-size failure on these fields is not realistic (tiny structs).  
Pre-existing: any `findByIdAndUpdate` failure still fails the render after bill; that is not introduced by these fields.

---

### 4. `adStage()` fire-and-forget

**medium | routes/ads.js:828–832 | writes `renderStage`/`updatedAt` with no status predicate | why:** heartbeat deliberately uses `{ _id, status: 'rendering' }` so it cannot touch ads cancel/reaper already moved. `adStage` matches only `_id`. After reaper → `queued`, cancel-archive of unclaimed work, or terminal `draft`/`failed`, a late `adStage` still overwrites `renderStage`, `renderStageAt`, and `updatedAt`. It does **not** flip `status` (so it does not resurrect a paid path by itself), but it pollutes the board sort (`updatedAt: -1`) and can make a finished/requeued ad look “live.” Unhandled rejection: no (`.catch(() => {})`).

**medium | routes/ads.js:923–931 | skipped Veo leaves stage = “master video generation” on a re-queued ad | why:** stage is stamped before `veoGenerateForAd`; on `skipped` the ad is set back to `status: 'queued'` with no stage clear. Board then shows a billable-looking stage on a non-rendering ad.

**low | routes/ads.js:828–832 | concurrent fire-and-forget stage writes can land out of order | why:** each call is unawaited; a slow earlier `updateOne` can overwrite a later stage + reset `renderStageAt`, which also breaks `stalled` (age measured from the late write). Telemetry-only.

---

### 5. `GET /api/ads/render-activity`

**Tenant (committed history):**  
**blocker (fixed) | routes/ads.js @ 4237455 | cross-tenant board | why:** original handler used optional `brandId` and `Ad.find({})` — any authenticated user could read other advertisers’ assets/prediction ids/URLs. **`fc02aee` requires `brandId` + `assertBrandInTenant`.** On current tip this is closed.

**Remaining on tip:**

**no findings** for unbounded query (cap 200), N+1 (≤3 queries), or returning full prompts (`imageGeneration` is selected but only `predictionId`/`pipeline`/`model` are projected; prompt is not in the JSON).

**low | routes/ads.js:1532 / 1567 | `assetUrl` = `renderUrl` | why:** not a credentialed secret (same class as ads list), but it is a cross-product creative URL any tenant member with brand access can dump in bulk. Acceptable if the board is operator-only by product intent; not a new credential leak.

**low | routes/ads.js:1525 | `derivedFromMaster` only true when `veoAspectRatio === '9:16'` | why:** masters that are 16:9 (Omni) cropped to 1:1/4:5 are mislabeled as not derived — board lies about “was this generated or cropped.” Diagnostic only.

---

### 6. CostLog `'submitted'`

**no findings** for double-count: one `recordFlatCost` at charge point; success path explicitly does not write a second row (`atlasVideoService.js:2673–2676`).

**medium | models/CostLog.js:22–26 + services/atlasVideoService.js:2624–2636 | successful video spend stays `status: 'submitted'` forever | why:** comments define `submitted` as “outcome not yet known,” but nothing ever patches the row on poll success/failure. Total `$sum: costUsd` is fine; any spend report that treats `ok` as “real spend,” or `submitted` as “in-flight / exclude,” permanently under- or mis-attributes **all** video. The enum fix stops the old coerce-to-`error` lie; it does not make status reflect outcome.

**low | services/atlasVideoService.js:2624–2636 | charge-point row omits `providerRequestId` | why:** image path can `reconcileCost` by prediction id; video cannot. Video rows stay `costSource: 'estimated'` even when Atlas later has actual price. Adjacent to the status work; not a double-charge, but keeps spend reports approximate for video.

---

### Summary

| Area | Verdict |
|---|---|
| Video fed `mediaIds` by fallback | **no findings** |
| Extra billable submit from fallback | **no findings** |
| `persistStage` new fields fail post-bill | **no findings** |
| `adStage` unhandled reject / status resurrection | no unhandled reject; no status flip — **but** status-blind `updatedAt`/stage writes + skip-path leftover stage are real |
| `render-activity` tenant leak | **blocker in 4237455; fixed in fc02aee** |
| CostLog double-count | **no findings** |
| CostLog forever-`submitted` | **medium** (report semantics) |

Nothing here looks like a silent second Atlas **submit** from the multi-ref fallback itself. Highest remaining post-fix risks: **stage telemetry lying after skip/cancel/reap**, and **video ledger rows that never leave `submitted`**, so status-filtered spend views stay wrong even after the enum fix.
