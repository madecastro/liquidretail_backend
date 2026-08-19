## 2026-08-11 — Stop storing THUMBNAILS as catalog hero images (branch `harden/catalog-scraper`)

**Defect (measured live, marinelayer.com):** same product photo two ingest paths —
products.json → 757,341-byte original; JSON-LD PDP → `_small` thumbnail **3,820 bytes**
(198× smaller). Hero is the DEFAULT AD SEED (`CATALOG_FEED_ORDER_SEEDING`), so the
thumbnail was feeding **billable** gpt-image-2 gens.

**Fix (UNCOMMITTED on this worktree):** pure `services/imageUrlUpgrade.js` —
`upgradeImageUrl` (Shopify size tokens + WP `-{W}x{H}` + resize query params;
preserves `?v=`) + `resolveUpgradedImageUrl` (injected `fetchHead`, fail-safe to
original on non-2xx / error / no verifier — a file named `photo_large.jpg` must
not become a 404). Wired into `genericCatalogResolver.imagesFromNode` /
`mapJsonLdProduct` / `mapOgProduct`: upgrade then de-dupe (collapse `_small` +
`_1024x1024` → one original; feed order preserved). Run-scoped memo +
`CATALOG_IMAGE_UPGRADE_MAX_CHECKS` (default 500). Flags default ON;
flag-off = no upgrades, no HEADs. Does NOT touch shopifyPublicIngestService
(products.json already originals).

**Harness:** `scripts/verifyImageUrlUpgrade.js` **49/49**. Revert-proof:
(i) drop HEAD verification → **42/49** (F1 false-positive fails);
(ii) de-dupe before upgrade → **46/49** (G1/G2/K2 collapse fails).
Full gate **80 pass / 0 fail** (79 baseline + new harness).

**NOT run live:** marinelayer catalog resolve — reviewer should.

