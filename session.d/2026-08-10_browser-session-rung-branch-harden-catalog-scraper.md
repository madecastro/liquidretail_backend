## 2026-08-10 — Browser session rung (branch `harden/catalog-scraper`)

**Defect (measured live):** ubeauty.com yields **0 products**. Shopify behind a
Cloudflare managed challenge — `/robots.txt` 200, but `/products.json`,
`/collections/all`, `/sitemap.xml` all **403** with `cf-mitigated: challenge`.
Auto-detect correctly fingerprints `shopify`, ladder + sitemap walk all blocked.
Proven remedy: real browser clears challenge → in-page
`fetch('/products.json?limit=250')` → HTTP 200, **all 103 products** (page=2 empty).

**Fix (UNCOMMITTED on this worktree):**
1. `services/headlessBrowserClient.js` — singleton Chrome + mutex + stealth +
   `gotoWithCf` (extracted from headlessScrapeService; one browser for the process).
2. `services/scrapeSession.js` — per-**host** session cache (scheme+host+port, NOT
   eTLD+1; www vs portal fanatics are different). TTL 10 min (CF clearance
   undocumented). `refreshInFlight` de-dupes; `refreshCount` cap 3.
3. **Harvest via `page.cookies(origin)` ONLY** — never `document.cookie` (HttpOnly
   `cf_clearance`/`__cf_bm` invisible to JS; trap harnessed).
4. `httpScrapeClient` optional `session` — pins UA verbatim, merges Cookie;
   flag-off `SCRAPE_SESSION_REUSE_ENABLED=false` = session never applied.
5. Paginated in-page products.json (was single page of 250).
6. `genericCatalogResolver` last rung: launch Chrome only when
   `browser-session` block seen / shopifyFallthrough / zero candidates with
   robots reachable; products still 0; budget left. Order: harvest → Shopify
   products.json → re-run cheap HTTP with session → honest failure.
7. Env: `RENDER_GENERIC_ENABLED`, `HEADLESS_STEALTH_ENABLED`,
   `SCRAPE_SESSION_*` (defaults true / 600000 / 3). Independent of
   `SHOPIFY_HEADLESS_RENDER` (still default off).

**stats keys:** `browserAttempted`, `browserMode`, `sessionHarvested`,
`sessionReused`, `browserProductCount`, plus `lastBlockVendor` /
`browserSessionBlockSeen`. `source` stays enum: `shopify-direct` |
`sitemap-jsonld`.

**Harness:** `scripts/verifyScrapeSession.js` **31/31**. Revert-proof:
(i) `page.cookies` → `document.cookie` → **30/31** (F1 fails);
(ii) remove UA pin → **30/31** (H1 fails). Full gate **79 pass / 0 fail**
(78 baseline + new harness).

**NOT run live:** ubeauty / PB5Star / Living Spaces catalog resolves — reviewer
should.

