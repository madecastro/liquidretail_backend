# 2026-09-06 — font-quality build (ranked list from the audit)

Local-only, not pushed. Sibling worktree
`/Volumes/Sayulita/Projects/RS/.wt-font-quality-build-backend` on
`feat/font-quality-build` off `origin/main` `ec64a9a5`. Paired adgen
worktree `.wt-font-quality-build-adgen`.

Implemented the audit's "genuinely missing" items 1, 3, 4, 5 (persist +
measured selector; no regex guess), 6, 7, plus the Chromium paint proof.

- **Paint proof PASSED.** Pelagic ArchivoV at FontFace `'700'` vs `'400'`:
  ink 22.46M vs 15.58M (ratio 1.44), advance width 630 vs 607. Chromium
  instantiates `wght=700`, not faux-bold off the file default of 600.
- **Item 5 selector:** live pelagicgear.com heading class is `.headline`
  (already in the regex). The `.headline` rule does not set `font-family`;
  headings inherit ArchivoV from `body`. Regex expansion skipped. Shopify
  persist no longer wipes a prior heading.
- **`FONT_ROLE_PAIRING_ENABLED` defaults false.** Do not turn it on until
  Soludos is re-ingested (out of scope; billable operator action).
- Did not re-ingest Soludos, did not port `fontAxisProbe` to adgen.

`npm test` 247/247 including `verifyVariableFontPaint.js`.
