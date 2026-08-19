## 2026-08-19 — Ad-readiness gate counted only the LEGACY apify-shopify ingest source

Found during live end-to-end QA: creating a campaign on **Vuori 2** (8,238 products,
7,964 generation-ready) was refused with *"Run an Apify sync from the Sales Demos page
before creating ads."*

Root cause: `services/adReadinessService.js` `probeConnections` counted
`CatalogProduct.countDocuments({ brandId, source: 'apify-shopify' })` — the only demo
ingest path when the gate was written. `shopify-direct` (the FREE public-storefront
ladder we now prefer) and `generic-sitemap` shipped later and were never added. The
gate's own header says the contract is "the demo's shopifyUrl WITH at least one product
row"; it was silently enforcing "…ingested by one specific deprecated method".

**Measured blast radius: 11 of 17 demo brands with a configured shopifyUrl were locked
out of creating a campaign at all, despite full catalogs** — Vuori 2 (9,185), Marine
Layer (2,444), Marine Layer 2 (2,295), GymShark, Peloton, PB5Star, Vuori Clothing,
Living Spaces, Fellow Products, Fanatics, Ubeauty. **Pelagic Gear (the first client)
passed only by accident**: it still carries 50 SOFT-DELETED legacy `apify-shopify` rows
beside its 824 live `shopify-direct` ones, so a hard delete of tombstoned rows would
have blocked it too.

Fix: count any live product for the brand (`{ brandId, deletedAt: null }`). The
`deletedAt: null` clause is load-bearing in the other direction — a brand whose entire
catalog has been tombstoned genuinely has nothing to advertise and must not read ready
off dead rows.

Pinned by `scripts/verifyAdReadinessIngestSources.js` (8 behavioural checks driving the
real exported `getAdReadiness` with models stubbed at the query layer). Revert-proven on
two mutations: restoring the `source:'apify-shopify'` filter fails S2/S3/S5/S7; dropping
`deletedAt: null` fails S4.
