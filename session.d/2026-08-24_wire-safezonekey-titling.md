# Wire safeZoneKey into the real titling call site (2026-08-24)

## The finding

PR #307 (`dabceaf4`, 2026-08-23) added surface-aware titling band geometry to
`services/plateIntelService.js`: `SURFACE_INSETS`, `bandsFor(safeZoneKey)`,
`REFERENCE_BAND_H`, `bandRect(bandKey, safeZoneKey)`. The stated contract:
derive the sampled brightness/texture/face-keep-out strip from the surface's
OWN safe-zone insets instead of one hardcoded `vertical`-shaped literal
(`BANDS = { bottom: [0.52, 0.65] }`) applied to every surface.

**Nothing ever supplied `safeZoneKey`, so the fix never fired on a single real
render.** Verified directly:

- `services/plateIntelService.js` `bandsFor(safeZoneKey)` — a null/absent key
  falls straight back to `BANDS`, the exact pre-fix literal.
- `services/remotionRenderService.js` `renderTitles({..., safeZoneKey = null})`
  accepts the param and forwards it correctly to `analyzePlate`/
  `applyFaceKeepOut` — this half was never broken.
- **But both real call sites, `services/brandScriptExecutor.js` (main render +
  the raw-plate retry), computed `platformFormat` and passed it to
  `renderTitles`, and never computed or passed `safeZoneKey` at all.** No other
  caller exists in `services/`/`routes/`.

So every titling run since PR #307 merged used `BANDS` — the pre-fix
behaviour — on every surface, including the four the fix specifically
targeted (`stories`, `squareYt`, `feed`, `square`, whose bottom insets are
0.06–0.14 vs the 0.35 the literal assumed). Backend's own investigation had
attributed a third of `layout_safe_box` vision-QC failures on a 63-ad sample to
exactly this geometry ("the caption overlay is placed directly on top of the
primary back logo, obscuring the brand name") — those failures were still
live, because the fix that was supposed to close them never ran.

**Why titling PLACEMENT (where the type actually lands) was unaffected, but
the plate SCAN (what ink/keep-out decisions get made from) was:**
`Canonical.jsx` (the ESM Remotion composition) resolves its own `zoneKey` at
render time — `const zoneKey = safeZoneKey || resolveSafeZoneKey({ format,
platformFormat })` — so the actual burned-in geometry has always been correct
regardless of whether an upstream caller pre-resolved the key. But
`analyzePlate`/`applyFaceKeepOut` run entirely on the CJS side, as a
pre-processing step over the raw video BEFORE the ESM composition ever runs —
there is no fallback resolution available to them at that point. Whoever
calls `renderTitles` has to hand them a real key, or they never get one.

## Why the gap wasn't visible in `scripts/verifyKeepOutBandGeometry.mjs`

The harness's original groups A-G are thorough about the PURE functions
(`bandsFor`, `bandRect`, `applyFaceKeepOut`) and about `remotionRenderService`
forwarding whatever key it's given (E1/E2). None of that touches whether
`brandScriptExecutor.js` ever computes a key to hand `renderTitles` in the
first place — so A-G stayed fully green the entire time the real call site
supplied nothing. This is the double no-op the task set out to find: "shipping
more plumbing that still no-ops."

## The fix

**Resolver:** `resolveSafeZoneKeyCjs({ format, platformFormat })`, added to
`services/plateIntelService.js` next to `SURFACE_INSETS`. It is a CJS mirror
of `remotion/lib/safeZones.js`'s `resolveSafeZoneKey` (and its
`PMAX_VIDEO_SAFE_ZONE_KEY` map), not an import — `remotion/package.json`
states outright that "the CJS app never requires these files directly" (an
architectural boundary, not a missing feature), and this is the exact same
reason `SURFACE_INSETS` already mirrors `SAFE_ZONES` and
`PANEL_CENTER_GUTTER_FRAC` is duplicated rather than imported. Mirroring is
the established pattern in this file, not a new one.

**Why mirroring, not a shared JSON file or dynamic `import()`:** a shared data
module was considered (§ task prompt) but rejected — it would be the ONLY
cross-CJS/ESM shared module in this codebase (three separate values already
mirror the same way, each with its own "why mirrored, not imported" comment)
and would require restructuring `remotion/`'s deliberately-isolated package
boundary for one small lookup table. A dynamic `import()` of the ESM file from
CJS is technically possible in Node but would violate the same stated
boundary and force every caller of the (currently synchronous) resolution
path to become async for no benefit — the mapping is five entries plus two
fallback rules, cheap to keep in sync with a drift-checking harness.

**How drift is prevented:** `scripts/verifyKeepOutBandGeometry.mjs` groups
H1-H4 import the REAL ESM `resolveSafeZoneKey` / `PMAX_VIDEO_SAFE_ZONE_KEY`
(not a hardcoded expectation list) and assert the CJS mirror agrees with them
for every entry in the real map (H1), that the two key sets are identical in
both directions (H2 — catches an extra CJS-only entry too, not just a missing
one), across every canvas format and unknown/absent input (H3), and for
case/whitespace handling (H4). A future entry added to the ESM map and not the
CJS mirror fails H1/H2 immediately, without anyone updating this harness.

**Call site:** `services/brandScriptExecutor.js` computes `const safeZoneKey =
resolveSafeZoneKeyCjs({ format, platformFormat })` once, right after
`platformFormat` is resolved, and passes `safeZoneKey` in both `renderTitles`
call sites (the main render and the raw-plate retry-on-crop-failure path).

## Execution proof — `bandsFor` now receives a real key

Ran directly against the fixed code (`node -e ...`, output captured verbatim):

| real (format, platformFormat) | resolved key | `bandsFor(key).bottom` | vs `BANDS.bottom` `[0.52, 0.65]` |
|---|---|---|---|
| `meta_stories_9_16` (vertical) | `stories` | `[0.52, 0.86]` | changed |
| `pmax_video_1_1` (square) | `squareYt` | `[0.52, 0.9]` | changed |
| `meta_feed_4_5` (feed) | `feed` | `[0.52, 0.94]` | changed |
| `meta_feed_1_1` (square) | `square` | `[0.52, 0.94]` | changed |
| `meta_reels_9_16` (vertical) | `reels` | `[0.52, 0.65]` | unchanged (correct — reels' bottom inset is 0.35, same as the literal) |
| `pmax_video_9_16` (vertical) | `verticalYt` | `[0.52, 0.65]` | unchanged (correct) |
| no PMax/Meta 9:16 mapping (vertical) | `vertical` | `[0.52, 0.65]` | unchanged (correct) |

Before this fix, `bandsFor(undefined)` — what every real render actually
passed — always returned `[0.52, 0.65]`, identical to `BANDS`, on every
surface.

## Regression check + mutation proof

New groups H (resolver drift), I (call-site wiring), J (end-to-end behavioural
proof) in `scripts/verifyKeepOutBandGeometry.mjs`. Three mutations run and
reverted, each proved red before restore:

1. **Drop `safeZoneKey` from both `renderTitles({...})` call sites** (the
   exact original bug, reproduced) → `I1` fails, everything else green.
2. **Decoy: keep the call-site token, hardcode `const safeZoneKey = null`**
   (tests that I1's presence check alone wouldn't have been enough) → `I2`
   fails specifically (I1 alone would have passed this mutation).
3. **Resolver drift: change one CJS mapping entry
   (`pmax_video_1_1: 'squareYt'` → `'feed'`)** → `H1`, `H4`, and `J1` all fail
   (the drift shows up both directly on the resolver and downstream in the
   real-shape behavioural check).

All three restored to a clean 32/32 pass after reverting.

## Fallback behaviour confirmed unchanged

`bandsFor`'s own inertness contract (group A — absent/unknown/genuinely
garbage `safeZoneKey` → `BANDS` verbatim, and its own inverted-strip guard at
`:196-198`) is untouched; the new resolver only ever hands `bandsFor` a key
that already has a `SURFACE_INSETS` entry (it fails closed to `'feed'`, itself
a real, non-inverted entry, for anything it can't map — J2/J3 pin this). No
surface is left falling back to `BANDS` that should be resolved — the four
named-defective surfaces (`stories`, `squareYt`, `feed`, `square`) all now
resolve and widen; `vertical`/`reels`/`verticalYt`/`landscapeYt` correctly
stay byte-identical to `BANDS` because their bottom inset already matches the
literal (0.35 / 0.35 / 0.35 / 0.36).

## Suite results

`npm test`: **198/200**, same two pre-existing failures as baseline
(`verifyPreparingReap.js`, `verifyRenderStages.js`) — unrelated to this change,
confirmed unaffected. `npm run lint`: clean.

## Companion fix

`liquidretail_adgen` has the identical gap (PR #54 ported #307's plumbing
faithfully, including the inert call site) — see that repo's own PR and
`session.md`/`session.d` entry.
