# 2026-09-03 — video reference path (packshot ranking, raw refs, seed-text filter)

Uncommitted working diff. No commit, no push. Full write-up:
`/Volumes/Sayulita/Projects/RS/scratchpad/IMPLEMENT-VIDEO-REFS-GROK.md`.

Two kill-switches, both default OFF:

- `VIDEO_PACKSHOT_PROTECTED_RANKING` — slot 0 reserved for `product_only`;
  slots 1–2 lifestyle → on-figure+face → on-figure → flat_lay → detail.
  `faceVisible === true` only; null is not a face. Operator stack bypasses.
- `VIDEO_RAW_CATALOG_REFERENCES` — skip input reframe/pad/outpaint; ship
  catalog `fileUrl`. Reframe machinery left in place, unreachable from the
  video path. Output-side `basePlateCropService` untouched.

`VIDEO_SEED_TEXT_TYPE_FILTER` was **stripped 2026-09-03**, not flag-gated.
The overlay "do not reproduce" guard contradicted `OMNI_DIRECTIVES.noText`
live at flag-off. See `/Volumes/Sayulita/Projects/RS/scratchpad/SEEDTEXT-STRIPPED.md`.

`npm test` 91/94 after the strip; the three reds are pre-existing (model-parity
mongoose intercept, regenerate in-flight merge-order gate, vendor-drift on
files we also ported to backend). `scripts/verifyVideoReferencePath.js` 35/35.
