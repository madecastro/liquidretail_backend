## 2026-08-19 — setImmediate background triggers: the remaining THREE ingest paths (phase 2)

Branch `fix/setimmediate-background-work`, worktree `.worktrees/setimmediate-backgroundwork`,
based on `origin/main` (`8db473c6`, i.e. PR #233 and #234 both already in).

**PR #233 fixed this bug in two of five places and it was never finished.** The pattern:
end-of-run background triggers (catalog enrichment, category inference, on-site review
scrape, brand enrichment) fired via `setImmediate(() => {...})`. `setImmediate` defers ONE
tick but does **not** keep the caller's Mongoose connection alive for that tick, so a
short-lived caller (a maintenance script that connects -> syncs -> disconnects) tears the
connection down first and the trigger throws *"Client must be connected before running
operations"* — silently, because every call site only `console.warn`s. Measured live on a
real Marine Layer re-ingest.

**The three paths #233 missed, all fixed here** (same shape: direct call, capture the
promise, expose as a `backgroundWork` array on the return value):

| path | function | triggers |
|---|---|---|
| Meta / IG-Commerce OAuth | `catalogSyncService.syncCatalogForCred` | enrichment + category inference |
| sitemap + JSON-LD | `genericCatalogIngestService.syncBrandGenericCatalog` | enrichment + category inference |
| legacy `apify` method | `apifyIngestService.syncBrandShopify` | enrichment |

**Propagation, which is where the two easy mistakes live.** `syncBrandApify`'s
**generic-sitemap** branch builds `out.shopify` field-by-field, so it needed an explicit
forward (like the shopify-direct branch #233 added); the **legacy** branch assigns the whole
summary (`out.shopify = await syncBrandShopify(...)`), so it rides along free — E3 pins that
shape so a future refactor to a field-by-field literal cannot silently drop it.
`syncCatalog`'s **multi-credential** path aggregates `backgroundWork` ACROSS credentials
(not last-wins like `totalCount`), and destructures it OUT of the `perCredential` rows,
which are pure data that get serialized.

**One HTTP boundary genuinely changed shape and was closed.** `routes/integrations.js`'s
sync-catalog route does `res.json(result)` on `syncCatalog`'s whole return object — a
Promise serializes to a useless `{}`, so the route now strips `backgroundWork` before
responding. Traced the other consumers: both capability executors
(`catalogSyncFromInstagram`, `catalogSyncFromGenericSitemap`, `catalogPullFromApify`,
`salesBrandSync`) build whitelisted `data` objects, and `routes/agent.js` only
`JSON.stringify`s into in-memory LLM tool-output messages — **no Mongo persistence, no
Mongoose cast, no crash** anywhere.

**Safety check on removing `setImmediate`:** the trigger now runs synchronously up to its
first `await`. `enqueueBrandProductEnrichment` is an `async function` (so a throw becomes a
rejection the existing `.catch` handles), `catalogProductEnrichmentService` has no circular
require back into the ingest services, and `runEnrichment`'s sync prefix is one `if`. The
sync never awaits the promise, so no lock deadlock.

**Verified:** `scripts/verifyIngestBackgroundWorkSurvives.js` extended from 8 to **21
checks** (groups C/D/E for the three paths, F as a cross-cutting sweep over all five entry
points). "No setImmediate" is asserted against **comment-stripped** source, because every
call site now carries a ROBUSTNESS comment narrating the old bug in prose. **Revert-proven
on seven mutations** (each restored `setImmediate`, each dropped `backgroundWork`, each
dropped forwarding, and the HTTP strip) — 18-20/21 on every one, 21/21 restored. Full suite
**168/168** (159 `.js` + 9 `.mjs`) and `npm run lint` clean. Worktree needed
`npm install --no-save https-proxy-agent@5.0.1 sharp` first (the tracked `node_modules`
subset is incomplete — CLAUDE.md §4).

**Not done, deliberately:** `syncBrandApify` still has no TOP-LEVEL aggregated
`backgroundWork` (a short-lived caller must read `out.ig.backgroundWork` and
`out.shopify.backgroundWork` separately) — that is the shape PR #233 established and
widening it was out of scope. The capability executors likewise still don't forward the
field; they are long-lived callers that never need it.
