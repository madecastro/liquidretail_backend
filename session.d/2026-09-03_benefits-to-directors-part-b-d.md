# 2026-09-03 — benefits-to-directors Part B + Part D

Worktree `/Volumes/Sayulita/Projects/RS/.wt-benefits-directors`, branch
`feat/benefits-to-directors` off `origin/main` `b4eb6435`. **Not committed.**
Part A (titling-director content sample) and Part C (static Director benefits)
were explicitly out of scope this call.

## Owner overrides applied (over the previous design pass)

1. **No `titleStyleSpecAuthoredAt` stamp.** Live prod audit (`liquidRetail`,
   2192 products / 2749 ads, newest ad the same day): 0 persisted
   `titleStyleSpec` on brands, catalogproducts, categories, ads; 0 brands pin
   `titleStylePreset`. The 2026-08-05 "stale specs shadow canonical"
   population is empty. Implemented **plain always-honour**: one cascade, no
   flag, no stamp, no new schema field, no write-site changes.
2. **No purge/migration script.** Nothing to purge.
3. **Do not add a benefits slot to any funnel preset JSON.** Placement is the
   titling director's choice. Known accepted consequence: staged funnel rows
   take TIER-0 `presetOverride`, which beats a persisted spec, so
   director-chosen benefits reach only the 506 unstaged video ads of 1516.
   Logged as follow-up, not fixed here.

## Part B — `TITLE_SPEC_IGNORE_PERSISTED` deleted

Cascade is now: `presetOverride` → persisted ad/product/category/brand
`titleStyleSpec` → `brand.titleStylePreset` → canonical. Title Studio and
render share it. `ignoresPersistedTitleSpecs` / `honourPersistedOverrides`
removed. Env key deleted from `config/defaults.env`.

## Part D — multi-slot stackFit + multi-bind rule

`estimateSlotHeightPx` special-cases `badges`/`benefits`:
- `stack`: n rows, each wraps on its own, plus (n-1)×gap
- `row`: historical joined-text model (one flex line)
- `grid`: 2 columns (matches `slotRenderers.jsx`), `ceil(n/2)` rows
- `maxItems` caps n (validator default 4); empty array → 0
Layout math lives in `stackFit.js` (vendor-synced). Canonical.jsx only grows
`estCtx`. Slot-key defaults (benefits→stack, badges→row) mean an unported
Canonical fork still estimates benefits honestly.

Validator: a `slotType==='multi'` bind must contain at least one of
`BINDABLE_MULTI_META_FIELDS`; a `{literal:[...]}` is legal only AFTER that
field (a leading literal always wins and would freeze SKU strings).

`itemDelaySec` schema-prompt wording corrected: it is a progress **fraction**
of the slot window (`slotRenderers.jsx:798`), not wall-clock seconds.

## Adgen port — STOPPED

`/Volumes/Sayulita/Projects/RS/liquidretail_adgen` is **not clean**:

```
 M config/defaults.env
 M scripts/vendor-manifest.json
 M session.md
 M src/models/Media.js
 M src/services/aiVideoReferenceService.js
 M src/services/atlasVideoService.js
 M src/services/referenceDefaultsService.js
 M src/services/veoPromptBuilder.js
?? scripts/verifyVideoReferencePath.js
?? session.d/2026-08-27_video-poll-livelock-and-reference-stack.md
?? session.d/2026-09-03_video-refs-packshot-raw-seedtext.md
?? src/services/seedTextPolicy.js
```

Branch `master` @ `8242275`. Did not edit it. `titleSpecService.js`,
`titleSpecValidator.js`, `remotion/lib/stackFit.js` are `synced` in
`scripts/vendor-manifest.json` — the port is still required for production
(adgen owns rendering) once that checkout is free. Canonical.jsx is
vendor-UNPORTED; stackFit defaults-by-slotKey cover the estCtx gap until
that fork grows the same three fields.

## Follow-up (accepted, not this diff)

Staged funnel rows take TIER-0 `presetOverride` (`canonical-{stage}` /
`-pmax10`), which beats a persisted spec, so a director-authored benefits
slot on a brand spec never reaches those rows. 506/1516 unstaged video ads
are the reachable set. Do not force benefits into funnel preset JSON (owner).
