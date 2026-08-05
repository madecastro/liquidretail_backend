# Agent capability coverage plan

**Status**: Phases 1 + 2 shipped (2026-08-05). Registry at 30 caps.

## Purpose

The home-page conversational agent shipped with **15 capabilities**. Audit
against actual product surfaces (~104 mutating REST routes across 18 route
modules + ingest paths like Apify/Brandfetch/Shopify) shows the agent covers
about **15% of the write surface**. Every strategic operation — brand setup,
campaign creation, integration OAuth, catalog ingest, team management — sits
outside the agent today.

Target state: **~72 capabilities across 11 phases**, so the operator can drive
the whole product from chat.

This doc is the plan. `server/docs/backlog.csv` carries one row per phase for
Jira import; those rows reference this doc.

## Design decisions

### D1. OAuth via URL, not via handshake

An agent running server-side cannot complete a browser OAuth redirect flow
from a chat window. Every `integrations.*.connect` capability returns a
**"click here to connect Meta"** URL as a Tier 1 result; the actual token
exchange stays on the existing `routes/integrations.js` handlers. Post-connect
selection (ad account, page, product set) is a normal Tier 1 capability that
reads state after the URL flow completes.

### D2. `getContext` scope: single-advertiser only

Adding cross-**advertiser** discovery would be a tenancy leak. `getContext` (a
new Tier 0 primitive) enumerates **the caller's own advertiser** — its
brands, active campaigns, current spend caps, connected integrations — so the
agent can answer "which of *my* brands has the most drafts" without
pre-selection. Cross-tenant discovery is off-limits and always will be.

### D3. Destructive team operations are Tier 3

`team.member.delete` and `team.invite.create` (sends email, external side
effect) are Tier 3 with explicit-phrase gates. Rationale: undoing a member
removal is a full re-invite + re-onboarding cycle.

### D4. External writes (Shopify push, Meta budget change) are Tier 3

Push-to-Shopify creates a real storefront artifact; Meta budget changes cost
real advertiser dollars. Both are irreversible from our side and warrant the
"type YES" ceremony.

### D5. Multi-service workflows stay Tier 4

Anything that fans out over N products/media (Shopify sync, Apify pull, brand
onboarding-from-URL) is a Tier 4 workflow with `preview()`/`execute()`. Same
pattern as the existing `catalog.refreshReviewsForBrand`.

### D6. Shopify Admin push requires a service build first

Per project memory (`project_veo_reels_pipeline.md` + prior sessions),
`pushToShopify.js` is legacy single-tenant + no video. A new
`shopifyProductMediaService` (Admin GraphQL `productCreateMedia`, per-brand
`IntegrationCredential`, `CatalogProduct.shopifyMediaIds` idempotency,
default-to-draft) must ship BEFORE the `shopify.pushProductMedia` capability
lands. Tracked in the Phase 8b backlog row.

## Phase table

| # | Phase | Caps | Tier mix | Rank | Depends on |
|---|-------|------|----------|------|------------|
| 1 | Campaigns | 10 | T1 × 8, T2 × 2 | High | — |
| 2 | Ad curation | 5 | T1 × 5 | High | — |
| 3 | Brand config | 8 | T1 × 5, T2 × 3 | High | — |
| 4 | Catalog & media | 12 | T1 × 6, T2 × 2, T4 × 4 | High | — |
| 5 | Onboarding | 4 | T1 × 3, T4 × 1 | High | Phase 3 (brand.*), Phase 4 (catalog.*) |
| 6 | Detection & layouts | 5 | T1 × 3, T2 × 2 | Medium | Phase 4 (media.*) |
| 7 | Team | 5 | T1 × 3, T3 × 2 | Medium | — |
| 8a | Integrations OAuth | ~10 | T1 × 10 | Medium | — |
| 8b | External writes | ~5 | T3 × 5 | Medium | 8a + `shopifyProductMediaService` build |
| 9 | `getContext` + cross-brand | 2 | T0 × 2 | Medium | — |
| 10 | Sales demos | 7 | T1 × 4, T4 × 3 | Low | Phase 4, 5 |

## Per-phase risk notes

### Phase 1 (Campaigns) — LOW RISK

Every executor is a Mongoose mutation with a tenant-filtered `findOne`. No
external calls except `campaign.deriveBrief` (LLM). Rollback = single revert
commit. Ships first.

### Phase 3 (Brand) — MEDIUM RISK

`brand.refreshEnrichment` and `brand.deriveVoice` invoke the LLM enrichment
pipeline — subject to the `DIRECTOR_SIGNALS_VERSION` cache-bump rule
(`server/CLAUDE.md` §00) if signal shape changes. Bump if fields shift.

### Phase 4 (Catalog & media) — MEDIUM RISK

`catalog.syncFromShopifyPublic` and `catalog.pullFromApify` are Tier 4
workflows that can enqueue very large batches. Each executor MUST cap
`MAX_STEPS_PER_RUN` (existing pattern: 100 for reviews, 50 for lifestyle
images).

### Phase 8b (External writes) — HIGH RISK

Money-adjacent. `shopify.pushProductMedia` writes real storefront rows.
`meta.updateBudget` moves spend caps. Explicit-phrase gates + audit log
required. Do not ship until `shopifyProductMediaService` has offline verify
coverage.

### Phase 9 (`getContext`) — LOW RISK BUT LOAD-BEARING

The Tier 0 primitive that lets the agent answer questions across brands
within one advertiser. Without it, the operator has to pre-select a brand
before every query — cripples the "one chat, everything" UX Variant B copy
promises.

## Non-goals

- **Cross-advertiser (tenant) discovery** — never a capability, ever.
- **Automated advertising bidding decisions** — the agent surfaces
  ads/campaigns to publish; the operator picks numbers. Automated bid
  adjustment is a separate product decision.
- **Ad account provisioning** — Meta/Google account creation flows sit
  outside our OAuth scope; agent only manages once connected.
- **Custom LLM tool authoring by operators** — the capability registry is
  the source of truth; operators can't add their own tools at runtime.

## Executor conventions (recap)

Every executor lives in `server/services/capabilityExecutors/<id>.js` and
exports either `run({ req, args })` (T0-T3) or `preview()` + `execute()`
(T4). Rules:

1. **First line of every executor**: guard `req.advertiserId`.
2. **Second line**: validate `ObjectId` args with
   `mongoose.isValidObjectId`.
3. **Every DB read**: filtered by `advertiserId` OR by a parent doc that was
   filtered by `advertiserId` (never both loose — the filter chain
   propagates).
4. **Return shape**: `{ ok: true, kind, data }` on success; `{ ok: false,
   error }` on validation/tenant failure. No throws to the endpoint (the
   agent's SSE loop treats a throw as a fatal turn error).
5. **T2 executors**: consult `spendGuard.reserve()` BEFORE dispatching
   billable work; the `estimateUsd` on the registry entry is the reservation
   amount.
6. **T4 executors**: `preview()` MUST be side-effect free and cheap.
   `execute()` re-derives the target list (drift between preview and
   confirm is expected). Both accept `{ req, args }`; `execute` also
   receives an optional `onProgress` callback.
7. **Kind field**: choose a stable string per resource kind
   (`campaign`, `campaignUpdate`, `brandUpdate`, `plan`,
   `workflowResult`, ...). Frontend `ResourceCard` renders one card per
   kind.

## Ownership + timeline

Owner: mark@reach-social.io.
Cadence: one phase per commit, pushed direct to trunk per the pre-release
rule (`feedback_liquidretail_direct_to_trunk_prerelease.md`). Each phase
should ship with:

1. Registry entries + executors
2. Frontend `ResourceCard.tsx` kind extension if a new resource shape
   emerges
3. Backlog row status flipped from "backlog" → "done"

## Referenced memories + docs

- `feedback_liquidretail_direct_to_trunk_prerelease.md` — commit-direct rule
- `feedback_liquidretail_placement_quality.md` — core-product framing
- `feedback_deterministic_over_gpt.md` — enrichment tier boundaries
- `server/CLAUDE.md` §2 (money invariants), §4a (Render dashboard rules)
- `server/docs/PIPELINES.md` §5 (Brand-led intent) — feeds Phase 3
