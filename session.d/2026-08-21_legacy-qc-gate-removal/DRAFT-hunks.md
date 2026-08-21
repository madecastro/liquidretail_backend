I'll draft exact hunks only — no edits. First I'll read the session handoff and the Grok coding skill, then locate every `adVisionQcEnabled` site and the five hot-path gate readers.Grok CLI local for this search. Next I’ll map every gate, schema field, env var, and harness that still mentions the legacy flag.Codegraph isn't indexed here, so I'll read the gate files and every write site directly. Next I'll confirm `isEnabled()` has no production callers.I'll next read the five hot-path callers, the harness files, and any admin-settings writers so the hunks match what's actually on this branch.Removal is the right cleanup **given your production read**. I did **not** re-query prod; that `staticVisionQcEnabled: true` / `videoVisionQcEnabled: true` fact is **owner-stated**, not re-verified here.

The five hot-path **call expressions** already read the split resolvers. This change deletes the third gate around them. It does not retarget those five calls.

Grok CLI local was available. Enumeration was grep + file reads (site listing, not a semantic hunt).

---

## 0. What stays frozen (do not touch)

| Thing | Where | Why |
|---|---|---|
| `PASS_FLOOR = 7` | `services/adVisionQcService.js:87` | Owner constraint. Harness B1. |
| `MAX_QC_REGENERATIONS = 1` | `:77` | Owner constraint. Harness B2. |
| Static regen-once-then-fail loop | `runPostRenderQc` body | Pipeline asymmetry. |
| Video never regenerates | `runVideoPostRenderQc` body | Same. |
| `parseVerdict` and helpers | `:501` onward | Other branch (`fix/qc-verdict-parser-tolerance`). |
| Persisted `reason: 'AD_VISION_QC_ENABLED=false'` | `:927`, `:1347`, plus the three early-return stamps | Frozen verdict identifier. Existing Ads + exact-match harnesses. **Not** a live env read. |
| `parseBoolEnv` / `staticEnvEnabled` / `videoEnvEnabled` | keep | Your explicit decision. |
| `peekStatic*` / `refreshStatic*` / `peekVideo*` / `refreshVideo*` | keep | New-gate API. Do not “simplify” them away. |
| `routes/members.js`, `routes/invitations.js`, `services/capabilityExecutors/` | do not open | Other branches. |

---

## 1. Exact hunks — production files

### 1.1 `models/SystemConfig.js`

Replace the three-field QC block (`:37-67`) with two fields and **no** legacy path.

```diff
@@ models/SystemConfig.js
-  // Post-render vision QC — LEGACY single gate, split 2026-08-21 into
-  // staticVisionQcEnabled / videoVisionQcEnabled below. KEPT, NOT REMOVED:
-  // this field is `true` in production right now and is the ONLY thing
-  // keeping QC on for both pipelines. It stays a live read-time fallback
-  // — see systemConfigService.getStaticVisionQcEnabled /
-  // getVideoVisionQcEnabled — so a deploy that adds the two new fields
-  // (both starting `null`, unset) does not silently drop to env/false and
-  // stop inspecting ads. Do not remove this field until both new fields
-  // have been deliberately populated (e.g. via a future admin settings
-  // screen) — removing it before then IS the "ships uninspected ads" bug
-  // this comment exists to prevent.
-  //   true  → force QC on  (wins over process.env.AD_VISION_QC_ENABLED)
-  //   false → force QC off (wins over env — explicit kill-switch)
-  //   null  → not set; fall through to env, then default false
-  adVisionQcEnabled: { type: Boolean, default: null },
-
-  // Post-render vision QC — STATIC pipeline gate (directImageRenderService,
-  // and imageRecoveryService since recovery is static-only). Same tri-state
-  // contract as the legacy field above. Access only via
-  // systemConfigService.getStaticVisionQcEnabled / setStaticVisionQcEnabled.
-  // Precedence when reading (see systemConfigService for the full cascade):
-  //   this field (if boolean) → legacy adVisionQcEnabled (if boolean,
-  //   backward-compat bridge) → STATIC_VISION_QC_ENABLED env (or legacy
-  //   AD_VISION_QC_ENABLED) → false.
-  staticVisionQcEnabled: { type: Boolean, default: null },
-
-  // Post-render vision QC — VIDEO pipeline gate (brandScriptExecutor). Same
-  // tri-state contract and precedence shape as staticVisionQcEnabled above,
-  // independent value. Access only via systemConfigService
-  // .getVideoVisionQcEnabled / setVideoVisionQcEnabled.
-  videoVisionQcEnabled: { type: Boolean, default: null },
+  // Post-render vision QC — STATIC pipeline (directImageRenderService +
+  // imageRecoveryService). Tri-state. Access only via
+  // systemConfigService.getStaticVisionQcEnabled / setStaticVisionQcEnabled.
+  //   true  → force QC on
+  //   false → force QC off (explicit kill-switch)
+  //   null  → not set; resolver falls through to env (unset ⇒ false)
+  // A leftover BSON `adVisionQcEnabled` on the singleton is inert: this
+  // schema no longer declares it, so Mongoose strict drops writes to it.
+  staticVisionQcEnabled: { type: Boolean, default: null },
+
+  // Post-render vision QC — VIDEO pipeline (brandScriptExecutor). Same
+  // tri-state contract, independent value. Access only via
+  // systemConfigService.getVideoVisionQcEnabled / setVideoVisionQcEnabled.
+  videoVisionQcEnabled: { type: Boolean, default: null },
```

**VERIFIED:** schema currently declares all three at `:51`, `:61`, `:67`.

---

### 1.2 `services/systemConfigService.js`

**Delete the entire legacy cache block** `:109-252` (`_adVisionQcCache`, `resetAdVisionQcEnabledCache`, `peekAdVisionQcEnabled`, `_storeAdVisionQcCache`, `getAdVisionQcEnabled`, `refreshAdVisionQcEnabledCache`, `setAdVisionQcEnabled`).

**Keep** `const AD_VISION_QC_CACHE_TTL_MS = 5000;` as the shared TTL for the two remaining caches (already aliased at `:279` and `:349`). Do not rename. Place it immediately above the split-gate section.

Rewrite the split-gate header (`:254-277`) so it no longer claims the bridge is load-bearing:

```js
// ── Split vision-QC gates: staticVisionQcEnabled / videoVisionQcEnabled ─
// Two independent tri-state caches, one per pipeline. Same 5s TTL.
// The legacy adVisionQcEnabled field / cache / bridge is gone: both new
// fields hold real values in production. A leftover BSON key on the
// singleton is not read.
```

**`getStaticVisionQcEnabled`** (`:305-321`) — drop the legacy select + bridge:

```diff
 async function getStaticVisionQcEnabled() {
   const now = Date.now();
   if (_staticVisionQcCache.loaded && now < _staticVisionQcCache.expiresAt) {
     return _staticVisionQcCache.value;
   }
   const cfg = await SystemConfig.findOne({ key: 'default' })
-    .select('staticVisionQcEnabled adVisionQcEnabled')
+    .select('staticVisionQcEnabled')
     .lean();
   const raw = cfg ? cfg.staticVisionQcEnabled : null;
-  let value = (raw === true || raw === false) ? raw : null;
-  if (value === null && cfg) {
-    const legacyRaw = cfg.adVisionQcEnabled;
-    if (legacyRaw === true || legacyRaw === false) value = legacyRaw;
-  }
+  const value = (raw === true || raw === false) ? raw : null;
   _storeStaticVisionQcCache(value);
   return value;
 }
```

Mirror that in **`getVideoVisionQcEnabled`** (`:375-391`): `.select('videoVisionQcEnabled')` only; no `legacyRaw`.

**`setStaticVisionQcEnabled` / `setVideoVisionQcEnabled` doc comments** currently say “fall back to the legacy field, then env”. Change to: “Pass `null` to clear (resolver falls through to env, then false).”

**`module.exports`** (`:419-452`) — drop the five legacy exports; keep `AD_VISION_QC_CACHE_TTL_MS` and the ten split-gate exports.

```diff
   setCanonicalScriptLandscape,
-  getAdVisionQcEnabled,
-  setAdVisionQcEnabled,
-  peekAdVisionQcEnabled,
-  refreshAdVisionQcEnabledCache,
-  resetAdVisionQcEnabledCache,
   AD_VISION_QC_CACHE_TTL_MS,
-  // Split gates (2026-08-21) — see the block above for the migration bridge.
   getStaticVisionQcEnabled,
   ...
```

**Why dropping it from `.select()` is load-bearing (INFERENCE, not a mongoose probe):** Mongo will still store `adVisionQcEnabled: true` on the existing singleton. A `.select('… adVisionQcEnabled')` is a Mongo projection; `lean()` can still return an undeclared path. Leaving the select + `legacyRaw` read would keep the bridge alive after the schema field is gone. Drop schema, select, **and** the `legacyRaw` block together.

---

### 1.3 `services/adVisionQcService.js`

**File header** (`:47-66`) — replace the “LEGACY fallback / bridge / resolveEnabled remain” paragraph with:

```js
// Feature flag resolution — two independent gates
// (`resolveStaticEnabled()` / `resolveVideoEnabled()`).
// Precedence (most specific first):
//   1. SystemConfig.<pipeline>VisionQcEnabled when typeof === 'boolean'
//   2. process.env.<PIPELINE>_VISION_QC_ENABLED via parseBoolEnv
//      (vars are intentionally ABSENT from config/defaults.env so a
//      committed `false` cannot disagree with the DB; unset ⇒ false.
//      A process-env / Render-dashboard value is the zero-deploy
//      emergency override if a SystemConfig read throws.)
//   3. default false
// A throwing SystemConfig read never rejects a render: catch → env → false.
```

**Keep `parseBoolEnv`** (`:129-131`) unchanged.

**Delete `envEnabled`** (`:140-142`), **`resolveEnabled`** (`:180-196`), **`isEnabled`** (`:293-309`).

**Rewrite `staticEnvEnabled` / `videoEnvEnabled`** so they no longer fall through to `envEnabled()`:

```diff
 function staticEnvEnabled() {
-  if (process.env.STATIC_VISION_QC_ENABLED !== undefined) {
-    return parseBoolEnv(process.env.STATIC_VISION_QC_ENABLED);
-  }
-  return envEnabled();
+  // Intentionally not in config/defaults.env. Unset ⇒ false (fail closed).
+  // A dashboard / process-env value is the Mongo-down escape hatch.
+  return parseBoolEnv(process.env.STATIC_VISION_QC_ENABLED);
 }

 function videoEnvEnabled() {
-  if (process.env.VIDEO_VISION_QC_ENABLED !== undefined) {
-    return parseBoolEnv(process.env.VIDEO_VISION_QC_ENABLED);
-  }
-  return envEnabled();
+  // Same contract as staticEnvEnabled, independent name.
+  return parseBoolEnv(process.env.VIDEO_VISION_QC_ENABLED);
 }
```

The `!== undefined` branch existed **only** to distinguish “unset → legacy `AD_VISION_QC_ENABLED`” from “set to empty/false”. With `envEnabled()` gone, `parseBoolEnv(undefined)` is already `false`. **VERIFIED:** `parseBoolEnv` is `String(raw || '').toLowerCase() === 'true'` (`:129-131`).

**`resolveStaticEnabled` docstring** (`:198-208`): drop “bridges to the legacy adVisionQcEnabled field” and “falls back to legacy AD_VISION_QC_ENABLED”. Precedence is now: DB boolean → `staticEnvEnabled()` → false.

Same for `resolveVideoEnabled`.

**`warnQcDisabledOnce` log line** (`:347-349`) — the log still names the deleted field. Update the text (D5 in `verifyAdVisionQcSurfacing.js` pins `/AD_VISION_QC_ENABLED is OFF/` and must move with it):

```js
`   ⚠️  adVisionQc: vision QC is OFF (SystemConfig gate unset/false and env unset) — every delivered ${mediaLabel} is shipping WITHOUT vision inspection until this is ` +
'turned on. Not a failure by itself — just make sure this is the intended state.'
```

**`runPostRenderQc` docstring** (`:867-873`): drop “bridged to legacy… Was resolveEnabled()”. Keep the `await resolveStaticEnabled()` call at `:901` as-is.

**`runVideoPostRenderQc` comment** (`:1334-1336`): drop “Was resolveEnabled()”. Keep the `await resolveVideoEnabled()` call at `:1336`.

**Do not edit** `:927` / `:1347` (`reason: 'AD_VISION_QC_ENABLED=false'`). Frozen identifier.

**`module.exports`** (`:1831-1834`):

```diff
   QC_MODEL_ROLE,
   // Flag / model
-  isEnabled,
-  envEnabled,
-  resolveEnabled,
-  // Split gates (2026-08-21)
   parseBoolEnv,
   staticEnvEnabled,
   videoEnvEnabled,
   resolveStaticEnabled,
   resolveVideoEnabled,
```

**`parseVerdict` starts at `:501`.** Do not edit `:490–1823` except the two doc-comments above and the `warnQcDisabledOnce` string.

---

### 1.4 `config/defaults.env`

Delete the three assignments (`:1308`, `:1318-1319`) and rewrite the “RUNTIME OVERRIDE” / “LEGACY” comments (`:1282-1319`) so this file stops claiming it is the live lever.

Replacement from the `RUNTIME OVERRIDE` heading through the blank line before `VIDEO_QC_DENSE_SAMPLING`:

```env
# LIVE LEVER is SystemConfig (Mongo singleton), NOT this file:
#   staticVisionQcEnabled  → static pipeline (directImage + image recovery)
#   videoVisionQcEnabled   → video pipeline (brandScriptExecutor)
# Flip with no redeploy / no restart:
#   await require('./services/systemConfigService').setStaticVisionQcEnabled(true)
#   await require('./services/systemConfigService').setVideoVisionQcEnabled(true)
# Both web and worker pick a flip up within the ~5s getter TTL.
#
# ENV READERS ARE KEPT as a fail-safe, but the names are INTENTIONALLY
# ABSENT from this file. A committed `false` here previously disagreed
# with SystemConfig `true` on the Mongo-throw / field-null path.
# Unset ⇒ false (fail closed). Setting STATIC_VISION_QC_ENABLED /
# VIDEO_VISION_QC_ENABLED in process env or the Render dashboard is the
# zero-deploy emergency override if Mongo is unreachable.
# A Mongo read failure logs once and falls through to that env/default;
# it can never throw into a render.
# Floors are unchanged: PASS_FLOOR=7, MAX_QC_REGENERATIONS=1.
# Fenced by scripts/verifyQcGateWiring.js.
```

Also fix the older sentence at `:1251` (“Flip this to false to stop both immediately”) and `:1262-1264` (“This file is the effective source”) — after this change those sentences are false. SystemConfig is the source; this file no longer carries the gate.

Leave `VIDEO_QC_DENSE_SAMPLING=true` (`:1337`) alone.

---

### 1.5 Hot-path callers — comments only, call sites already correct

**VERIFIED** current calls (do not change the `await` lines):

| # | File | Line | Call |
|---|---|---|---|
| 1 | `services/directImageRenderService.js` | 2594 | `await adVisionQc.resolveStaticEnabled()` |
| 2 | `services/imageRecoveryService.js` | 352 | `await adVisionQc.resolveStaticEnabled()` |
| 3 | `services/brandScriptExecutor.js` | 1685 | `await adVisionQc.resolveVideoEnabled()` |
| 4 | `runPostRenderQc` (same-module lexical) | 901 | `await resolveStaticEnabled()` |
| 5 | `runVideoPostRenderQc` (same-module lexical) | 1336 | `await resolveVideoEnabled()` |

`qcAndStampVideoAd` (`brandScriptExecutor.js:1883`) does **not** re-check the gate; it calls `runVideoVisionQcForAd`. `adRegenerateService` reaches static QC via `renderDirectImage` and video QC via `qcAndStampVideoAd`.

Optional comment edits (the comments still name `SystemConfig.adVisionQcEnabled` as if it were the live flag):

- `directImageRenderService.js:2585`
- `imageRecoveryService.js:347`
- `brandScriptExecutor.js:1679`

Change those to `staticVisionQcEnabled` / `videoVisionQcEnabled`. Do not change the `reason: 'AD_VISION_QC_ENABLED=false'` stamps at `:2609`, `:357`, `:1690`.

---

## 2. Every `adVisionQcEnabled` reference — keep / remove

**VERIFIED** from repo-wide grep of `*.{js,mjs}` plus `config/defaults.env`. Session/docs history is listed so you don’t “fix” a log.

### Writes (must not be orphaned)

| Site | Verdict |
|---|---|
| `models/SystemConfig.js:51` schema field | **REMOVE** |
| `services/systemConfigService.js:245` `doc.adVisionQcEnabled = enabled` inside `setAdVisionQcEnabled` | **REMOVE** (delete the whole setter) |
| `scripts/verifyQcGateWiring.js:92` stub `adVisionQcEnabled: stubDbValue` | **REMOVE as a live field.** Re-add as a leftover-BSON fixture on the inversion pin (below). |

No HTTP route writes it. **VERIFIED:** `setAdVisionQcEnabled` has no production caller outside its own definition + the wiring harness. Design doc (`session.d/2026-08-21_admin-settings-and-qc-gate-split-DESIGN.md:94`) said the same; still true on this branch (diff vs `main` has no `routes/` files).

### Reads / exports — production

| Site | Verdict |
|---|---|
| `getAdVisionQcEnabled` `.select('adVisionQcEnabled')` `:212-214` | **REMOVE** |
| `getStaticVisionQcEnabled` `.select('… adVisionQcEnabled')` + `legacyRaw` `:311-317` | **REMOVE** |
| `getVideoVisionQcEnabled` same `:381-387` | **REMOVE** |
| exports of get/set/peek/refresh/reset AdVisionQc* `:427-431` | **REMOVE** |
| Schema comments `:37-60` | **REMOVE / rewrite** |
| Split-gate header claiming the bridge is load-bearing `:262-277` | **REWRITE** |

### Dead legacy API on `adVisionQcService`

| Site | Verdict |
|---|---|
| `resolveEnabled` `:180-196` | **REMOVE** |
| `envEnabled` `:140-142` | **REMOVE** |
| `isEnabled` `:293-309` | **REMOVE** |
| their `module.exports` `:1832-1834` | **REMOVE** |
| `staticEnvEnabled` / `videoEnvEnabled` fallback `return envEnabled()` | **REMOVE the fallback; KEEP the functions** |

**`isEnabled()` production call sites: VERIFIED zero.** `adVisionQc.isEnabled(` / `qc.isEnabled(` appear only in:

- `scripts/verifyQcGateWiring.js`
- `scripts/verifyAdVisionQc.js` E2
- `scripts/verifyAdVisionQcSurfacing.js` (comments + D6 *absence* pin + stubs)
- `scripts/verifyImageRecovery.js` (belt-and-braces stub)
- `scripts/verifyVideoQcFrameSampling.js` (belt-and-braces stub)

No match in `services/` or `routes/` except comments and the definition.

### Frozen identifier (keep the string, it is not the field)

| Site | Verdict |
|---|---|
| `reason: 'AD_VISION_QC_ENABLED=false'` in `runPostRenderQc`, `runVideoPostRenderQc`, three early returns | **KEEP** |
| Harness exact matches of that reason | **KEEP** |
| `docs/ALERTING.md:973,990` historical incident | **KEEP** (log, not a gate) |
| `session.md` / `session.d/*` | **KEEP** (do not edit history) |

### Comments that still describe the live flag (update with the hunks)

`adVisionQcService.js` header, `warnQcDisabledOnce`, the three caller comments, `config/defaults.env` override docs, `models/Ad.js:460` (“Null when AD_VISION_QC_ENABLED is off”) — that last one is already slightly wrong (gate-off now stamps a disabled verdict, it does not leave `visionQc` null). Optional; not load-bearing.

---

## 3. Harness plan

Suite claim of **184 green** is **INFERENCE** from your prompt; this session did not run `npm test`.

### `scripts/verifyQcGateWiring.js` — this is the one that will go red

**Stub / reset (`:69-120`)**

- Drop `stubDbValue` as the live legacy field.
- Drop `systemConfig.resetAdVisionQcEnabledCache()` from `resetAll`.
- Keep returning leftover BSON on the stub document **for the inversion pin**:

```js
lean() {
  return Promise.resolve(
    stubDbValue === undefined
      ? null
      : {
          key: 'default',
          staticVisionQcEnabled: stubStaticDbValue,
          videoVisionQcEnabled: stubVideoDbValue,
          // leftover BSON from the retired schema field — getters MUST ignore it
          adVisionQcEnabled: true
        }
  );
}
```

(`stubDbValue === undefined` is still the “no document” idiom used by N8.)

| Check | Move | Why |
|---|---|---|
| **A1** “schema declares `adVisionQcEnabled`” | **(a) invert, do not delete** | Absence pin: `assert.ok(!paths.adVisionQcEnabled)`. Deleting A1 would let the field come back silently. |
| **A2** get/set/peek/reset on the *legacy* cache | **(b)** | Re-point at static+video get/set/peek/reset. **Keep** the `AD_VISION_QC_CACHE_TTL_MS > 0 && <= 30_000` pin — that constant still drives both remaining caches. |
| **A3** exports `resolveEnabled` + `envEnabled` + `isEnabled` | **(a) invert** | `typeof qc.resolveEnabled === 'undefined'` (and envEnabled, isEnabled). Same for `systemConfig.getAdVisionQcEnabled`. |
| **A4** “legacy field must stay” | **(a) invert** | Drop the `assert.ok(paths.adVisionQcEnabled)` line; keep the two new-field default-null pins. Default-null still means “unset → env → false”, **not** “unset → bridge”. |
| **A5** split-gate surface | **(b) trim** | Keep resolvers / env helpers / parseBoolEnv / static+video get/set/peek/reset. Delete “Legacy exports must stay”. |
| **A6** `defaults.env` contains the three names | **(a) invert** | `assert.doesNotMatch(src, /^AD_VISION_QC_ENABLED=/m)` and the same for `STATIC_` / `VIDEO_`. This is what actually fences “vars gone from the file, reader retained”. |
| **B1 / B2** PASS_FLOOR=7, MAX_QC_REGENERATIONS=1 | **keep** | Money floors. |
| **C1–C2, D1–D5, E1–E5, F1–F3** (legacy `resolveEnabled` / `envEnabled`) | **(a) delete** | L1–L8 and M1–M8 already pin the same contracts on the live resolvers. Keeping C/D/E/F would test deleted API. |
| **G1–G5** TTL on `getAdVisionQcEnabled` | **(b)** | Re-point every `getAdVisionQcEnabled` / `resetAdVisionQcEnabledCache` / `peekAdVisionQcEnabled` / `resolveEnabled` to the **static** getter/cache/peek + `resolveStaticEnabled`. Same TTL mechanics. Video cache independence is already N9. |
| **H1–H6** Slack notifyAsync | **keep** | Unrelated to the legacy field. |
| **I1 / I2** `isEnabled()` vs warm cache | **(a) delete** | `isEnabled` is being deleted. The production path is the async getter; G + L already cover it. |
| **K1** peek survives past TTL | **(b)** | Re-point to `peekStaticVisionQcEnabled` after warming `getStaticVisionQcEnabled`. Peek still exists on the new gates and still must not treat expiry as “unknown”. |
| **K2–K4** `isEnabled()` past TTL / cold→env | **(a) delete** | They exist to pin the 2026-08-20 sync-peek race. That function is going away; the async path was never racy. |
| **K5** `resolveEnabled()` across TTL | **(b)** | Re-point to `resolveStaticEnabled({ getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled() })`. Respect the lexical-vs-export subtlety: this check already injects deps, so it is interceptable. |
| **J1** source contains `adVisionQcEnabled:` | **(a) invert** | `assert.doesNotMatch(src, /adVisionQcEnabled\s*:/)`. |
| **J2** split fields + “legacy kept” | **(b)** | Keep static/video path pins; drop `assert.match(src, /adVisionQcEnabled\s*:/)`. |
| **L1–L8 / M1–M8** | **keep**, drop `stubDbValue = null` “no legacy bridge” comments | These **are** the live precedence suite. L6/M6 (throw → env true) and L7/M7 (throw + unset → false) are the fail-closed pins. |
| **N1–N7** migration bridge | **(a) delete the bridge-true checks; replace with inversion** | See new N1 below. N3–N5 (explicit new-field wins) stay useful **without** a legacy contrast: they already assert the new field is the whole decision. |
| **N8** no document → getter null | **keep** | Still true; not a bridge test. |
| **N9** independent TTL caches | **keep** | Copy-paste shared-cache bug. |
| **O1–O4, P1–P2** independence / wrong dep key | **keep** | Split-gate integrity. |
| **Q1–Q5** `parseBoolEnv` | **(b) trim `qc.envEnabled()`** | Keep parseBoolEnv + `staticEnvEnabled` + `videoEnvEnabled`. Drop every `qc.envEnabled()` assertion. Drive Q with `STATIC_`/`VIDEO_` env names only (not `AD_`). |
| **R1–R8** env bridge from `AD_VISION_QC_ENABLED` | **(a) delete R as written; replace with one inversion** | R1/R5 currently **require** the legacy env name to enable QC. After this change that would be a fail-open leak. New pin: `AD_VISION_QC_ENABLED=true` + STATIC/VIDEO unset → both env helpers **false**. |
| **S1 / S2** enabled-omitted fallback | **(b) drop the `getAdVisionQcEnabled` spy** | After the export is gone, `systemConfig.getAdVisionQcEnabled = …` is assigning a new property, which proves nothing. Spy static vs video only. Keep the lexical-binding comment — it is still true. |
| **S3 / S4** swap-one-getter independence | **keep** | Behavioural, intercepts `require('./systemConfigService').get*`. |
| **S5 / S6** source fallback names | **keep** | `!/\bresolveEnabled\s*\(/` becomes a real absence pin on the function body once the function is deleted. |

**New inversion checks (do not skip these):**

```js
await checkAsync('N1 leftover BSON adVisionQcEnabled=true does NOT enable static QC', async () => {
  resetAll();
  stubStaticDbValue = null;   // new field unset
  stubVideoDbValue = false;
  // stub document still carries adVisionQcEnabled:true (see installStub)
  const dbVal = await systemConfig.getStaticVisionQcEnabled();
  assert.strictEqual(dbVal, null,
    'getter must return null, not the leftover legacy BSON true');
  const resolved = await qc.resolveStaticEnabled({
    getStaticVisionQcEnabled: () => systemConfig.getStaticVisionQcEnabled()
  });
  assert.strictEqual(resolved, false,
    'resolver must not resurrect the retired field via select() or a leftover bridge');
});

check('R1 AD_VISION_QC_ENABLED=true does NOT enable staticEnvEnabled/videoEnvEnabled', () => {
  resetAll();
  process.env.AD_VISION_QC_ENABLED = 'true';
  delete process.env.STATIC_VISION_QC_ENABLED;
  delete process.env.VIDEO_VISION_QC_ENABLED;
  assert.strictEqual(qc.staticEnvEnabled(), false);
  assert.strictEqual(qc.videoEnvEnabled(), false);
});
```

N1 is the check that fails if someone “removes the schema field” but leaves `.select('… adVisionQcEnabled')` + `legacyRaw`. That is the silent-bridge class.

**Monkey-patch rule (your empirical note, still true):** `runPostRenderQc` / `runVideoPostRenderQc` call `resolveStaticEnabled` / `resolveVideoEnabled` as **same-module lexical bindings**. Patching `qc.resolveStaticEnabled` does not intercept. S1–S4 must keep patching `require('../services/systemConfigService').getStaticVisionQcEnabled` / `getVideoVisionQcEnabled` on the shared module object. Do not “fix” S by stubbing `qc.resolve*`.

---

### `scripts/verifyAdVisionQc.js`

| Check | Move | Why |
|---|---|---|
| Header claim that E2 no-ops `refreshAdVisionQcEnabledCache` | **(a)** rewrite header | That path dies with `isEnabled`. |
| **E1** `enabled: false` → no vision, no regen | **keep** | Passes an explicit boolean; never hits SystemConfig. Money pin. |
| **E2** `isEnabled()` reads `AD_VISION_QC_ENABLED` | **(a) delete** | Tests the function you are deleting. Re-pointing it at `staticEnvEnabled()` would duplicate Q. |
| **A3** `parseVerdict` | **keep, do not edit** | Other branch owns that parser. |

---

### `scripts/verifyAdVisionQcSurfacing.js`

| Check | Move | Why |
|---|---|---|
| **A2 / D2 / D3 / F3** `reason === 'AD_VISION_QC_ENABLED=false'` | **keep** | Frozen identifier, not the env var. |
| **D4 / D6** callers await `resolveStaticEnabled` / `resolveVideoEnabled`, must not call `isEnabled` / `resolveEnabled` | **keep** | Already the post-split pin. Stronger once the symbols are gone. |
| **D5** `/AD_VISION_QC_ENABLED is OFF/` | **(b)** | Re-point the regex at the new `warnQcDisabledOnce` text (e.g. `/vision QC is OFF/`). |
| `withStubbedAdVisionQc` `isEnabled` / `resolveEnabled` stubs | **(a) delete those two stub keys** | Dead after the export removal. Keep `resolveStaticEnabled` / `resolveVideoEnabled`. Leaving the extra keys would not fail; deleting them makes a future `isEnabled()` call throw in this harness instead of silently using a stub. |
| F6 stub (`:963-973`) same two keys | **(a) delete** | Same. Keep `resolveVideoEnabled: async () => true`. |

---

### `scripts/verifyImageRecovery.js`

| Check | Move | Why |
|---|---|---|
| **G1 / G2** stale `disabled:true` does not satisfy the pre-spend guard | **keep** | Money. Gate is already `resolveStaticEnabled`. |
| `staleDisabledStamp.reason` | **keep** | Frozen identifier. |
| `origIsEnabled` / `origResolveEnabled` stub + restore | **(a) delete** | Belt-and-braces for deleted API. Keep `resolveStaticEnabled = async () => true`. |

---

### `scripts/verifyVideoQcFrameSampling.js`

| Check | Move | Why |
|---|---|---|
| **G2** threads selector output into the vision call | **keep** | Needs `resolveVideoEnabled` stubbed `true` so the real `runVideoVisionQcForAd` does not hit Mongo. |
| `isEnabled` / `resolveEnabled` stub + restore (`:626-627`, `:663-664`, `:689-690`) | **(a) delete** | Same belt-and-braces. Keep `resolveVideoEnabled`. |

---

### Other `verify*` files

**VERIFIED:** no other `scripts/verify*.js` references `adVisionQcEnabled` or `getAdVisionQcEnabled`. Hits on `isEnabled()` in `verifyModerationSeedFallback.js` / `verifyIngestShotClassify.js` are **other modules**.

Do not weaken B1/B2, L/M throw-fallback, O/P independence, S3/S4 getter-swap, or the five-site D6 resolver-name pin to make the suite green.

---

## 4. Fresh boot, SystemConfig unreachable, env unset — fail closed

**VERIFIED control flow:**

1. Boot (`index.js:1-5`, `worker.js:18-20`): process env first, then `config/defaults.env` with dotenv **no override**.
2. After this change those three names are **absent** from the file, so unless the Render dashboard or a local `.env` set them, `process.env.STATIC_VISION_QC_ENABLED` / `VIDEO_VISION_QC_ENABLED` are `undefined`.
3. First static render: `await adVisionQc.resolveStaticEnabled()` (`directImageRenderService.js:2594`) with `deps = {}`.
4. That does `require('./systemConfigService').getStaticVisionQcEnabled` — live property lookup — then `await getCfg()` (`adVisionQcService.js:212-214`).
5. `getStaticVisionQcEnabled` `findOne().select().lean()` **throws**.
6. `resolveStaticEnabled` **catches** (`:216-224`), logs once, does **not** rethrow.
7. `return staticEnvEnabled()` → `parseBoolEnv(undefined)` → `String('').toLowerCase() === 'true'` → **`false`**.

Same for video (`:232-247` → `videoEnvEnabled()`).

QC does **not** run. Ads ship with the disabled stamp (`reason: 'AD_VISION_QC_ENABLED=false'`). That is fail-closed for **spend** (no vision LLM call) and fail-open for **quality** (uninspected ads ship). That polarity is the existing contract (`:177-178`, `:216`), not new.

If Mongo is up and `staticVisionQcEnabled: true` (your prod read), step 5 returns a boolean, step 6 never runs, env is never consulted, QC is on.

Emergency hatch: dashboard `STATIC_VISION_QC_ENABLED=true` while Mongo is down → catch → `parseBoolEnv('true')` → QC stays on. That is why the reader stays after the file assignment is gone.

---

## 5. What is unsafe

**I would not keep the legacy field.** The design doc’s “do not remove until both new fields are populated” condition is the thing you say you just verified. The leftover BSON key remains in Mongo and is inert **if and only if** schema + select + `legacyRaw` all go.

Real risks, ranked:

1. **This session did not re-read production.** If `staticVisionQcEnabled` / `videoVisionQcEnabled` are not actually real booleans on the live `{key:'default'}` doc, this deploy turns QC **off** and the leftover `adVisionQcEnabled: true` **cannot** save you — N1 is written to guarantee that. After deploy, confirm one live static and one live video ad stamp a real `visionQc` (not `disabled:true`).

2. **`null` on a new field now means OFF**, not “bridge to legacy true”. Today `setStaticVisionQcEnabled(null)` still enables QC in prod via the bridge. After this, `null` → env unset → false. The upcoming admin “reset to default” **must write `true`, not `null`**, if default-on is what you want. Writing null is a silent QC-off.

3. **`AD_VISION_QC_ENABLED` leftover on a machine.** Local `.env` or a forgotten dashboard var of the **old** name will no longer enable anything. Only `STATIC_VISION_QC_ENABLED` / `VIDEO_VISION_QC_ENABLED` remain as env hatches. CLAUDE.md §4a says the dashboard is secrets-only, so this is unlikely in prod (**INFERENCE** from that doc, not a live dashboard list this session).

4. **Mongoose strict:** a later `doc.adVisionQcEnabled = false` or mongo `$set` of that path becomes a silent no-op in-app. Anyone still running the old `setAdVisionQcEnabled` snippet from `defaults.env` comments will think they flipped QC. The comment rewrite in §1.4 is what stops that.

5. **`parseVerdict` conflict.** This change’s surface is the top-of-file gate block, `module.exports` flag keys, `warnQcDisabledOnce`, two doc-comments, and `verifyQcGateWiring.js`. `parseVerdict` is `:501`. If `fix/qc-verdict-parser-tolerance` only edits the parser and its helpers, merge should be clean. If that branch also rewrote the file header or `module.exports`, expect a conflict — stop and don’t resolve it by touching `parseVerdict`.

6. **Not unsafe, stated so it isn’t “fixed” later:** keeping `reason: 'AD_VISION_QC_ENABLED=false'` after the env var is gone looks sloppy. It is a persisted contract. Renaming it would churn every exact-match harness and every already-stamped Ad. Leave it.

I do **not** believe removing the legacy field is wrong on the evidence you gave. The unsafe move would be removing the field **and** the inversion pins, or removing the env **readers**.
