## 2026-08-05 (later) — OPERATOR VIDEO PICKS ARE THE WHOLE STACK. UNCOMMITTED

Owner: *"When the user overrides the default and chooses the images and the order to send to the
video model ... they are the only images sent, and they are sent in the order demarcated by the
ordering icons (1,2,3)."* and *"if it doesn't have a catalog image just signal the user there is no
catalog image and if they choose to override that is at their discretion."*

**Order was already correct end-to-end** — frontend `toggleSeed` appends in pick order, the badge is
1-based pick order, `referenceMediaIds = picks.slice()`, and `buildReferenceImages` ordered path
skips catalog assembly. The ONLY violation was the **PRODUCT ANCHOR append**: when no pick was a
catalog mirror, `expandDeterministicVideo` appended a catalog image the operator never chose.

**Now (kill switch `VIDEO_OPERATOR_STACK_ONLY`, default ON):** never append. `firstCatalogMediaForProduct`
is still probed but ONLY to choose a warning code. The product still queues.

**The signal needed a NEW channel, not a new REASON.** `normalizePerProductEntry` does
`const reason = raw.skipped || raw.reason; const skipped = !!reason` — stamping a reason on a
product that QUEUED would mark it `skipped:true` and replace its "Queued 1 creative(s)." message.
So: a separate `WARNING` enum (`no_catalog_in_picks` / `no_catalog_image`), a separate `warning`
field that never touches `skipped`, a human clause APPENDED to the success message, and
`warning: String` added to `models/CampaignRun.js` perProduct (Mongoose strict silently DROPS
undeclared keys — that alone would have made the whole feature a no-op).

### THE DEFECT THIS CHANGE INTRODUCED, caught in adversarial review

`hasProductAnchor = imageUrls.length >= 2` was a COUNT proxy for "the stack contains catalog
imagery". It was only ever safe **because the append guaranteed a catalog image**. Removing the
append broke its precondition: three lifestyle/UGC picks would still satisfy `length >= 2`, and
`hasProductReference` gates a prompt sentence asserting *"All supplied images show the exact catalog
SKU — the rest are additional views of the same product"*. That would be asserted as the source of
truth for shape/colour/label over three unrelated social shots, on a ~$1 render.
Now `imageUrls.length >= 2 && stackHasCatalogRef`, where the operator-ordered stack is judged on its
own Media docs (`metadata.catalogProductId === ad.productId`) and auto-assembly stays true by
construction. Pinned by group F.

### MONEY — digest shift, documented not "fixed"

`computeDeterministicVideoDigest` hashes `referenceMediaIds`. Dropping the anchor CHANGES the digest
for any stack that previously got one, so a re-Generate with the same non-catalog picks mints a NEW
ad and can bill once more. It does NOT double-bill within one expansion, and identical post-change
stacks still dedupe. Correct — a different stack IS a different creative.

**Verify:** new `scripts/verifyOperatorVideoStack.js` (W/P/K/S/D/F groups), **6 revert-proven
mutations** including a `concat` re-append that `.push`-only pins would have missed. Full suite
**66 scripts, 0 failing**.

**Still to do:** the SPA does not yet render `perProduct[].warning` as chrome. The advisory IS
already visible in the appended `message` text, so this is polish, not a gap.

---

