## 2026-08-05 (later) — FRONTEND catalog display audit

Owner: *"any time you display catalog images they should be shown in feed order, primary first,
then the alts."* Audited every catalog-image display site in `liquidretail/frontend/app`.

**Already compliant.** No site re-sorts catalog multi-image sets by shotType, adSuitability,
score, engagement or createdAt. `catalogImagery` is built primary-then-alts in feed order and every
rail consumes that order.

**The scary-looking `scored.sort((a,b) => b.score - a.score)` in `Step2Picker.tsx` (~2337) is NOT a
violation** — verified directly: `scored` holds UGC media, brand-match posts, and product ENTITY
tiles only; `catalogImagery` is explicitly `void`ed at :2345 and alts live in the per-product rails.
It is deliberate ad-fit ranking of UGC. Do not "fix" it.

**One real gap, fixed:** `CatalogBrowser/ImageGallery.tsx` never listed alts in its thumb strip —
its own header comment promised additionalImages thumbnails and `GalleryEntry` declared a
`'additional'` kind that nothing ever produced. The strip is now the full feed set (primary, then
alts in `additionalImages` order, then judged crops), and the left-rail alt selection now resolves
to that entry's index instead of a parallel single-tile hack. `tsc -b --noEmit` clean.

---

