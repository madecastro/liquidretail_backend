# CHANGELOG — liquidretail_backend

Session-by-session history. **`session.md` is the live handoff and must stay trim** — anything
here is settled history and does not belong there. If you are looking for what is TRUE NOW,
read `session.md`; this file only answers "when did that change, and why".

Newest first.

## 2026-08-18/19 — Pelagic Gear onboarding: price/currency incident found + fixed, catalog re-ingested 57→831

**Root cause of the ~19.97-19.99x inflated `CatalogProduct.price` on Pelagic Gear
(source:'apify-shopify'), found and fixed, NOT a cents/dollars unit bug.**
`Brand.apifyDemo.shopifyUrl` was pointed at `za.pelagicgear.com` — a real,
independently-operated South-African Shopify store (`/meta.json` →
`{"currency":"ZAR","country":"ZA"}`), not a presentment variant of the US
store. Every stored price was the CORRECT ZAR list price, silently mislabeled
`currency:"USD"` by the Apify actor. Fixed:
- **Data**: `apifyDemo.shopifyUrl` corrected to `https://pelagicgear.com` via
  `PATCH /api/sales-demos/brands/:id` (not a raw DB write).
- **Code**: `services/shopifyAccessResolver.js#verifyStoreCurrencyUsd` — cross-checks
  a target storefront's real `/meta.json` currency before either ingestion path
  (`apifyIngestService.syncBrandShopify`, `shopifyPublicIngestService.syncBrandShopifyDirect`)
  trusts it; refuses on a CONFIRMED mismatch (before the PAID Apify call spends
  anything), does not block on an inconclusive check. `models/CatalogProduct.js`
  now documents the USD-major-units unit contract explicitly.
- **Defense in depth**: `remotion/components/slotRenderers.jsx` `PriceSlot` no
  longer does a blind `` `$${raw}` `` concat (would have printed e.g. "$2999" for
  any untrusted upstream number); now formats via `remotion/lib/priceFormat.js`
  and renders nothing rather than a number it cannot vouch for. Unreachable in
  production today (no live titleStyleSpec has a visible price slot; static/Director
  prompts ban price text) but a preset with one already exists in the repo
  (`babyboo-editorial-monochrome.json`) — this closed a real, if currently dormant,
  landmine. The wrong number HAD already reached `Ad.copy.productPrice` (shown in
  app UI) on real draft/failed Pelagic ads before this fix — not retroactively
  corrected here, flagged as a follow-up.
- Pinned by `scripts/verifyCatalogPriceCurrencyGuard.js` (27 checks, revert-proven
  on 4 mutations). Full write-up: `docs/PIPELINES.md` §1 *Price & currency contract*.

**Catalog re-ingested 57 → 831 live products (100% of the 824-product live
storefront + 7 detect-identified), via the FREE `shopify-direct` public
storefront ladder** (not Apify — see `session.md` for the "no native Shopify
connector exists" finding). The 50 stale `apify-shopify` rows (wrong price,
dead handles) were soft-deleted via the existing `catalog.bulkDeleteProducts`
capability (reversible; cascade-cleaned 2 Campaign refs, 1 Media ref, 174
Ad.productId refs — no Ad creative was touched, `copy`/`renderUrl` snapshots
are frozen at render time). 31 of the 50 matched a live product under a new
colorway-suffixed handle (reconciled); 19 appear genuinely discontinued.

See `session.md` for full timing/bottleneck data and the generation-readiness
test.

## 2026-08-03

Prod moved `a80ae0b` → `f96e0a6` after 24 fixes had sat unpushed for a day, so every QC
observation before this date was made against a binary that was never deployed.

- **Zero-ads root cause fixed.** The Director's schema moved `media_picks` under `routing` (v3);
  the producer dual-read both shapes and logged `warnings=0` while **six** consumers still read
  the flat v2 location and discarded everything. Unified on `services/conceptProjection.js`.
  Verified live: `payloads=0` → `payloads=3`.
- **`/runs` double-charge closed.** It lacked the atomic `status:'queued'` claim `/generate` has;
  two clicks of "render next batch" billed Atlas twice for one ad.
- **Telegram → Slack**, delivery proven end-to-end by a real spend alert. The token had been
  sitting in a Render env GROUP with `serviceLinks: []`, reaching no process.
- **600-second status blind spot closed** on both render paths, piggybacked on existing poll
  ticks; verified live on video (`17s (1)` → `1m24s (5)`).
- **Untitled videos no longer reported as success** — and the fix caught a real failure on its
  first live run.
- **Grounded quotes printable again** (~82% of social proof) with attribution structurally
  stripped. `llm-web` is grounded Google Search, not fabrication; the defect was always the
  byline, including `vertexaisearch.cloud.google.com` printed as a customer 80 times.
- **Hero-image default** (`DIRECTOR_UNIVERSE_TOP_N` 10 → 1), per-product skip reasons,
  `GET /api/ads/formats`, 404 guard on unmatched ad paths, video quote gate, per-run Slack feed.
- **Docs corrected**, three false claims killed — including `CLAUDE.md` contradicting itself on
  video money in the section headed "violating these costs real cash".

## Earlier

- **2026-08-02** — Director reasoning quarantined; presets platform-grouped, Google frozen;
  `CLAUDE.md` §00 written; the video model corrected to **Omni, not Veo**; concurrency knobs to env.
- **2026-08-01** — measured 4 independent Omni submits for one campaign/product on the
  non-preset path.
- **2026-07-31** — static delivery geometry, fabricated proof and snippet inversion fixed;
  provenance found inert end to end; Render shell access set up.
- **2026-07-30** — static-ad diagnostics; the image-ref "photoreal polish" shadow stopped running.
- **2026-07-29** — Atlas facts verified: 720p and 1080p identically priced; Omni prompt cap
  20,000 chars; no image or video endpoint supports a system prompt.
- **2026-07-27** — video batch stalls diagnosed; Telegram alerting built (since replaced by
  Slack); reaper false-reap window closed.
- **2026-07-23** — pipeline cost/perf pass; `config/defaults.env` introduced.
- **2026-07-22** — generic sitemap + JSON-LD catalog scraper after the Living Spaces incident
  (livingspaces.com is not Shopify).
- **2026-07-21/22** — org repos stood up; SPA cutover to Netlify; Render backend live.
