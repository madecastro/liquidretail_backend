## 2026-08-19 — Pelagic Gear stale ad price snapshots repaired (61 rows), 15+7 held/flagged

Brand `6a4d27f47b13860ec3a2f56b`. `Ad.copy.productPrice` is a render-time cache
(`renderService.js:1441-1451`, `extractCopySnapshot`: Number → `` `$${price.toFixed(2)}` ``,
currency ignored) fed from `CatalogProduct.price` via `layoutInputService.js:819-823`. Before
today's `apifyDemo.shopifyUrl` fix + re-ingest (separate session, PR #221/#222), that price came
from `za.pelagicgear.com` (ZAR) — every cached string was **~19.99x too high** (e.g. Squall Jacket
$2799.00 cached vs $140.00 live).

Ran `scripts/fixPelagicAdPriceSnapshots.js` (dry-run → APPLY=1) via a Render one-off job against
prod. Premise checked first: **0 of 218** ads for this brand carry any Meta-sync marker
(`metaSyncStatus`/`metaAdId`/`metaAdsetId`/`metaAdCreativeId`/`metaSyncedAt`), so the guard on
"never touch a synced ad" was structurally satisfied, not just assumed.

**61 rows written and independently re-read-verified** (0 failures) — `copy.productPrice` moved,
`headline`/`cta_text`/`quote`/`productName` confirmed byte-identical before vs after on every row:

| before | after | rows |
|---|---|---|
| $1299.00 | $65.00 | 29 |
| $2999.00 | $150.00 | 14 |
| $599.00 | $30.00 | 9 |
| $699.00 | $35.00 | 3 |
| $2799.00 | $140.00 | 3 |
| $1499.00 | $75.00 | 3 |

Today's separate re-ingest (57→831 catalog rows, 50 old rows soft-deleted) had already nulled
`Ad.productId` on 82 of the 93 candidate ads, so a plain productId join alone resolved only 14 rows.
The script falls back through `LayoutInputArtifact.productId` → exact `normalizedTitle` → Shopify
**handle** containment (handles carry the colorway a bare title strips, e.g.
`squall-jacket-solid-petrol`) → handle with separators removed (catches glued forms like
`vaportek-hooded-brushcamo-fade-*`) → fuzzy title/handle similarity, with the FX ratio
(old-price ÷ candidate-price) used ONLY to disambiguate when a tier found >1 candidate price — never
as the sole signal. All 61 written rows cluster tightly at ratio 19.967–19.993, corroborating every
resolution independently of the name-match logic.

**15 rows held, not written** — same name/handle match but ratio outside [19.5, 20.5] (e.g. a Mako
kayak at 18.39x across 9 same-priced color variants, a Lighthouse product at 24.9x). Could be a
real US-side price change rather than a bad match; script refuses to guess. Needs a human look —
rerun with `ALLOW_OOB_DETERMINISTIC=1` after eyeballing, or patch by hand via `ad.patch`.

**7 rows left untouched — pre-existing data fault, not part of this repair:** 3 "Heathered Strappy
Bra" product/ad pairs (7 Ad docs) carry a `productId`/`LayoutInputArtifact.productId` that resolves
to a CatalogProduct row belonging to a **different brand** (`6a6a4f58054561c15f3ffa1a`). Their
$21.00 price was never ZAR-derived — flagged for separate investigation, not fixed here.

**Known NOT fixed (same brand, same root cause, out of this task's scope — see script header)**:
`LayoutInputArtifact.input.product.price` (cached Number, not invalidated by re-ingest —
`layoutInputService.js:324-335`), `Ad.titlingSnapshot.meta.price` (video chrome only; this brand's
93 candidates were all `product_image`/`ugc` static, so untested here), `CreativeDirectionArtifact
.inputSummary.product_signal.price`. The already-rendered PNG/MP4 for any of the 61 ads still shows
the OLD price text — same caveat as `adPatch.js` — regenerate to update pixels.


---

**Follow-up (added when this entry was landed, 2026-08-19):** the "7 rows left untouched"
cross-brand finding above was NOT just a data fault — it was a live code defect. `POST
/api/ads/generate` never asserted that passed `productIds` belong to the campaign's brand, and
`buildSeededUniverse`'s product-mode catalog query filtered on `metadata.catalogProductId` with no
`brandId` clause, so an unowned productId resolved the *other* brand's media into a real, billable,
fully cross-branded ad. A fix was written the same night but left uncommitted in the shared
checkout for 9 hours; it is being landed separately. See that PR for the tenancy assertion and
`scripts/verifyGenerateProductTenancy.js`.

**Provenance:** the script in this PR (`scripts/fixPelagicAdPriceSnapshots.js`) was committed as
`80d8add1` on a branch that never had a PR opened. Only the script is carried forward here; the
original commit's `session.md` half was written against the pre-#238 6,962-line format and is
reproduced above as a `session.d/` entry instead.
