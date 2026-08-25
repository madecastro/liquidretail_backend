# Wire safeZoneKey into the real titling call site (2026-08-24)

Companion fix to `liquidretail_backend`'s
`session.d/2026-08-24_wire-safezonekey-titling.md` — same defect, same fix
shape, independently confirmed on this side of the fork. Built on top of the
open `port/backend-307-titling-band-geometry` branch (PR #54), which ported
backend #307's plumbing faithfully — including the gap.

## The finding

PR #54 ported backend #307's surface-aware titling band geometry
(`SURFACE_INSETS`, `bandsFor(safeZoneKey)`, `bandRect(bandKey, safeZoneKey)`,
`REFERENCE_BAND_H`) into `src/services/plateIntelService.js`, and wired
`renderTitlesJob`/`renderPreview` in `src/services/remotionRenderService.js`
to forward whatever `safeZoneKey` they're given — a faithful, correct port of
that half.

**But nothing on adgen's side ever computed a `safeZoneKey` either.** Both
`renderTitles({...})` call sites in `src/services/brandScriptExecutor.js`
(main render + the retry-on-cropped-plate-failure path) had `platformFormat`
in scope and passed it straight through, never deriving `safeZoneKey` from
it. Verified directly (`grep -n "safeZoneKey" src/services/
brandScriptExecutor.js` before this fix: zero matches). Same shape, same
consequence: `bandsFor` always received `undefined` and fell back to the
pre-#307 `BANDS` literal on every real render, on every surface.

## The fix

Identical mechanism to the backend fix, adapted to this repo's `src/`
layout: `resolveSafeZoneKeyCjs({ format, platformFormat })` added to
`src/services/plateIntelService.js` next to `SURFACE_INSETS` — a CJS mirror
of `src/remotion/lib/safeZones.js`'s `resolveSafeZoneKey`, for the exact same
CJS/ESM-island reason `SURFACE_INSETS` is already mirrored rather than
imported (`src/remotion/package.json`: "the CJS app never requires these
files directly"). `brandScriptExecutor.js` computes `safeZoneKey` once and
forwards it to both `renderTitles` call sites.

Drift between the CJS mirror and the real ESM map is pinned by new harness
groups I/J/K in `scripts/verifyKeepOutBandGeometry.mjs` (this port's existing
groups run A-H, so the new groups pick up at I, not H). Group I imports the
real ESM `resolveSafeZoneKey`/`PMAX_VIDEO_SAFE_ZONE_KEY` and asserts the
mirror agrees in both directions; group J pins the call site actually
forwards a resolved key, not a decoy `null`; group K executes the real
resolver→`bandsFor` chain end-to-end for the real `(format, platformFormat)`
shapes production Ad rows carry.

## Execution proof

```
=== BEFORE (every render pre-fix: safeZoneKey always undefined) ===
bandsFor(undefined).bottom = [0.52,0.65]

=== AFTER: real (format, platformFormat) pairs ===
meta_stories_9_16 (stories): key="stories" bottom=[0.52,0.86] changed=true
pmax_video_1_1 (squareYt): key="squareYt" bottom=[0.52,0.9] changed=true
meta_feed_4_5 (feed): key="feed" bottom=[0.52,0.94] changed=true
meta_feed_1_1 (square): key="square" bottom=[0.52,0.94] changed=true
meta_reels_9_16 (unaffected): key="reels" bottom=[0.52,0.65] changed=false
pmax_video_9_16 (unaffected): key="verticalYt" bottom=[0.52,0.65] changed=false
```

## Mutation proof

1. Drop `safeZoneKey` from both `renderTitles({...})` call sites (the exact
   original gap, reproduced) → J1 fails.
2. Decoy: keep the token, hardcode `const safeZoneKey = null` → J2 fails
   specifically (J1 alone would have missed this).
3. Resolver drift (`pmax_video_1_1: 'squareYt'` → `'feed'`) → I1/I4/K1 all
   fail.

All three restored to a clean 35/35 pass after reverting.

## Suite results

`node scripts/runVerifySuite.js` (NODE_PATH unset, no `npm ci`): **40/43**,
identical to the PR #54 branch tip BEFORE this change (confirmed via
`git stash` bisection) — `verifyRunFinalizesOnSettle_KNOWN_OPEN.js`
(documented expected-fail) and `verifyModelParity.js` +
`verifyVendorDrift.js` (both pre-existing, unrelated to this change — the
vendor drift is against files this PR does not touch, e.g.
`adVisionQcService.js`/`directImageRenderService.js`/
`imageRecoveryService.js`, and is a known, already-flagged backend-sync gap,
not introduced here).

`scripts/verifyKeepOutBandGeometry.mjs` standalone: **35/35** (was 25 on
PR #54's branch tip).

## vendor-manifest.json

Updated the `reason` field for both `services/brandScriptExecutor.js` and
`services/plateIntelService.js` to record this follow-up fix.
`backendHash`/`backendSha` left untouched — this is not a re-sync against a
newer backend commit (backend's own fix for the identical gap is an open,
unmerged PR as of this writing), just documenting the incremental change.

## Companion PR

`liquidretail_backend` has the identical fix, same day, same session — see
that repo's own PR and `session.d/2026-08-24_wire-safezonekey-titling.md`.
