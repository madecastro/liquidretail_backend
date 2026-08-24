# 2026-08-24 — drop reviewer bylines that cannot attribute (`— D`)

Branch `fix/attribution-viability`. Not pushed. A delivered Pelagic Gear video
ad rendered a review attribution as literally `— D` under the customer quote.
`slotRenderers.jsx` prepends the em-dash; the stored reviewer was the bare
initial `"D"` from a scraped product review. That identifies nobody.

`usableAttribution` / `letterCount` already lived in `services/quoteProvenance.js`
(Unicode `\p{L}`, threshold 2). This session wired that one helper into both
render paths and pinned it.

- Video: `brandScriptExecutor.buildMetaForAd` wraps `cascaded.reviewer`.
- Static: `directImageRenderService.buildIntentData` wraps `quote.author_name`
  and keeps the absent shape as `undefined` (not `null`).
- Harness: `scripts/verifyAttributionViability.js` (52 checks, offline).
  Revert-proven: identity helper, video unwired, static unwired, threshold
  lowered to 1, and a wrap-then-fallback (`|| cascaded.reviewer`) — each
  went red, then restored clean. The fifth mutation is load-bearing: a
  prefix-only regex on `usableAttribution(cascaded.reviewer)` stayed green
  while still painting `— D` (adversarial review).

Does not change printability (`toPrintableCustomerQuote` still admits a quote
whose byline is `"D"`). Does not filter `Anonymous` / `Guest` / `Verified Buyer`.
