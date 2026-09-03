# 2026-09-03 — video reference path (packshot ranking, raw refs, seed-text filter)

Uncommitted working diff. No commit, no push. Full write-up:
`/Volumes/Sayulita/Projects/RS/scratchpad/IMPLEMENT-VIDEO-REFS-GROK.md`.

Same two flags as adgen (`VIDEO_PACKSHOT_PROTECTED_RANKING`,
`VIDEO_RAW_CATALOG_REFERENCES`), both default OFF.

`VIDEO_SEED_TEXT_TYPE_FILTER` and `seedTextPolicy.js` were **stripped
2026-09-03**. Inspector `seedHasTextFromMedia` is now a raw `Media.text`
length (no type filter). Overlay guard retired; `OMNI_DIRECTIVES.noText`
is the sole text directive. See
`/Volumes/Sayulita/Projects/RS/scratchpad/SEEDTEXT-STRIPPED.md`.

`npm test` 234/234 after the strip. `scripts/verifyVideoReferencePath.js` 35/35.
`verifyTruthfulReporting` 66/66. `verifyLifestylePreserve` 419/419.
