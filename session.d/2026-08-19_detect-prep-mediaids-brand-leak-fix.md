# 2026-08-19 — detect-prep `mediaIds`→brandId leak closed (PR #245 review finding #1)

Branch `fix/detect-media-brand-tenancy`, off a clean worktree at `origin/main`
(`d78795c3`, the commit that landed #248's write-up of this exact finding).

## The bug

An adversarial (Grok, `--effort xhigh`) review of PR #245 — which closed a
cross-brand tenant leak on POST `/generate`'s `productIds` — found the same
missing-`brandId` pattern in six other places `productIds`' new ownership
check never reaches. This PR closes the ONE finding from that review already
confirmed **both real and currently exploitable on the deployed code**:

`services/campaignAdsGenerationService.js`'s `expandWizardJob`, inside its
on-demand catalog-detect prep (`if (!dryRun) { ... }`, ~line 1330), resolves
the request body's raw, **unfiltered** `mediaIds` via
`Media.find({ _id: { $in: mediaIds... } })` with no `brandId` clause, unions
each hit's `matchedProducts[].catalogProductId` into a Set, and calls
`ensureDetectForProducts(ids, { advertiserId, brandId })`
(`services/catalogProductDetectService.js`). That function **accepts** a
`brandId` option — but before this fix used it only to stamp an
`OperationRun` label (`brandId: brandId || products[0].brandId`); its own two
`CatalogProduct.find` calls (the oids-based ownership-collapse query, and the
primaryOids-based imageUrl/materialize query) were unscoped.

Net effect: a POST `/generate` with a foreign brand's UGC/catalog `mediaId`
in the request body can still trigger `enqueueProductDetect` — a **billed**
Gemini vision call — against another brand's `CatalogProduct`, regardless of
what `productIds` contains or how tightly #245 filters it. This is a live
money + tenant-isolation leak independent of, and not reached by, what #245
closed — #245's own comment that `buildSeededUniverse`'s brandId clause is
"the thing that actually stops the leak when productId itself is
compromised" is only true for the seeded-universe read; this is a
completely separate `Media.find` in a completely separate service.

## Prod evidence (measured 2026-08-19, read-only Render one-off jobs —
`render jobs create srv-d1vuktqli9vc73ft07ng`, `MONGODB_URI` already in env
there, payload base64-inlined to sidestep quoting)

- **8 campaigns' persisted `Campaign.mediaIds` currently reference
  foreign-brand `Media` docs** (4 distinct campaigns, 4 distinct brand pairs:
  Pelagic Gear Test 2↔Marine Layer 2, Pelagic Gear↔Peloton, Pelagic
  Gear↔Vuori Clothing, Peloton↔GymShark). **0 of the 8 are cross-advertiser**
  (all within-advertiser, cross-brand). All 8 look like leftover QA/test
  fixture pins (`campaignName` values are generic — "Summer Sale", "Summer
  Branding", "Peleton Test") rather than real customer data.
- **All 8 have `matchedProductsTotal: 0`** — the Media docs never had
  product-match detect run against them, so **today's persisted residue
  cannot currently chain into a foreign `CatalogProduct` via this exact
  path** (there's no `matchedProducts` entry to union into `ensureIds`). This
  is a fact about the *current data*, not about the *code path*: a fresh
  request supplying a foreign brand's already-matched UGC `mediaId` (any
  Media doc with a populated `matchedProducts[].catalogProductId` pointing
  cross-brand) would still trigger the leak on the pre-fix code. The bug is
  in the code, not contingent on today's data happening to exploit it yet.
- Separately, `Campaign.matchedProductIds` (the legacy pre-#245 field) still
  holds **14 foreign-brand product ids across 9 campaigns** — inert now that
  `/generate`'s `productIds` are ownership-filtered at request time by #245,
  but noted as residue.

## The fix, two parts

1. `services/campaignAdsGenerationService.js` — the detect-prep `Media.find`
   gained a `brandId` clause (the campaign's own `brandId`, already in scope
   as `const brandId = String(campaign.brandId)`).
2. `services/catalogProductDetectService.js` — `ensureDetectForProducts`'s
   two `CatalogProduct.find` calls gained a **conditional** brandId clause
   (`brandId ? { brandId } : {}`). Conditional, not a hard filter, because
   `services/productMatchService.js` (~881, post-scale detect pre-warm) calls
   this function with `brandId: ctx.brandId || null` — an internal match
   result, not a request-body tenant to check against; a hard filter would
   silently break that legitimate caller.

**A structural nuance found while building the harness, worth recording
so nobody "fixes" it again:** of the two `CatalogProduct.find` calls in
`ensureDetectForProducts`, only the **second** (the one that actually
produces `products`, the array everything downstream operates on) is
independently security-load-bearing. The first query's scope is a strict
subset of what the second re-checks — whatever candidate ids the first query
lets through as `primaryOids`, the second query's own `brandId` clause
filters again before anything can be returned. Scoping the first query is
real and kept (it narrows the candidate set for a caller-supplied `oids`
list — a query-cost concern, not a tenancy one), but it is not
independently exploitable on its own; only the second query's scope is. The
harness (`scripts/verifyDetectPrepMediaTenancy.js`, section B/M2) proves
this rather than asserting the opposite — an earlier draft of the harness
tried to revert-prove the first query's scope as independently
security-critical and the assertion turned out to be **false** (removing it
alone left the function's output unchanged), which is exactly the kind of
mistake a revert-prove step exists to catch before it ships as a false
claim.

## Verification

- New harness: `scripts/verifyDetectPrepMediaTenancy.js` (8 checks). Section
  A is a **structural source anchor** (brace-balanced slice of the
  `if (mediaIds.length) { ... }` block, then of the `Media.find({...})`
  object literal inside it, keys parsed after stripping line comments) —
  chosen because the detect-prep block is inline inside `expandWizardJob`,
  not its own exported function, so it can't be required + monkey-patched in
  isolation without dragging in that function's full dependency graph.
  Section B is **behavioral**, against the real exported
  `ensureDetectForProducts`, with a faithful `CatalogProduct.find` stub (same
  convention as `scripts/verifyGenerateProductTenancy.js`'s
  `installCatalogProductFindStub` — it actually applies the `_id`/`brandId`
  clauses it receives) and a permissive `DetectRun.find` stub (reports every
  candidate already-detected, so the function short-circuits via
  `wait:false` before ever touching `materializeImage`/`enqueueProductDetect`
  — those are `scripts/verifyCatalogHeroMaterialize.js`'s concern, out of
  scope here). Three scenarios: owned+foreign ids with a real `brandId`
  (only the owned one reachable); the same ids with `brandId: null`
  (`productMatchService`'s caller — proven NOT regressed, both stay
  reachable); a same-brand variant whose `primaryProductId` points
  cross-brand ("bad data" case Grok's fix rationale called out — correctly
  filtered to zero).
- Revert-prove: M1 (drop `brandId` from the `campaignAdsGenerationService.js`
  `Media.find`) flips section A red. M3 (drop the scope from the second
  `CatalogProduct.find`) flips the cross-brand-variant scenario red. M2 is
  **not** a revert-prove — see the nuance above — it asserts the documented
  non-effect of dropping only the first query's scope, so it would itself go
  red if that ever became false.
- **Proved for real, not just via the harness's internal mutation
  mechanism**: stashed the actual two-file fix out of the working tree and
  re-ran both the new harness and a plain `node` invocation of the affected
  functions. Section A's structural check and section B's `ensureDetect
  ForProducts` scenarios both independently showed the vulnerable behavior
  (the owned+foreign scenario returned `total: 2` instead of the fixed
  code's `1`; the cross-brand-variant scenario returned `total: 1` instead
  of `0`) — not just the harness's own constructed mutations reporting
  success. Restored and re-ran green (8/8).
- No regression: `scripts/verifyGenerateProductTenancy.js` (the #245 harness)
  still 25/25 after this fix.
- Full offline suite + `npm run lint`: see the numbers this PR's description
  cites (re-counted at land time, per `CLAUDE.md` §5 — the count drifts).

## The other five findings from the same review — corrected, not just re-cited

An earlier write-up of this review (`session.d/KNOWN-OPEN.md`, since
updated) took the review's claims for #2/#3/#5/#6 close to verbatim. A
second, independent Grok pass (`--effort high`, told explicitly to be
adversarial toward the FIRST review, not just toward the code) plus my own
line-by-line reads of every cited file:line materially corrected the
severity picture. This is the accurate version, keep it:

- **#4** (`firstCatalogMediaForProduct`, the deterministic-video seed path) —
  **confirmed, still latent.** Every query in it (`CatalogProduct.findById`,
  two `Media.findOne` calls) is scoped to `catalogProductId`/`source`, never
  `brandId`. Not reachable through `/generate` today because `productIds`
  are ownership-filtered before reaching it post-#245. Not touched by this
  PR — tracked as its own follow-up.
- **#2** (`/preview` has no ownership check) — **confirmed missing, but the
  blast radius is much narrower than first reported.** On the LIVE path
  (`AI_CONCEPT_DRIVEN=true`, the actual default — see #5 below),
  `dryRun` skips both the detect-prep block AND the live mint; the estimate
  branch (`campaignAdsGenerationService.js` ~1608-1636) computes billable
  counts by pure arithmetic over the request's `productIds` array — it does
  **not** read any foreign brand's actual catalog or media, so "reads/misreports
  another brand's data" was an overclaim for this path. It only misquotes
  the ESTIMATE (treats every requested productId as owned for counting
  purposes) — not billable, not tenant-data-exposing, on the path that
  actually runs today. The narrower flag-OFF cartesian path (`seedsFromProduct`/
  `seedsFromMedia`, same file ~2233/~2386) genuinely reads foreign
  product/media in-process and can even trigger `enqueueProductDetect` (a
  real write/spend) via its lazy-materialize branch — but that path is
  itself gated behind #5's flag state (see below).
- **#3** (`resolveOwnedProductIds` doesn't dedupe `productIds`) — **confirmed,
  real money, not tenant-exposing.** `routes/ads.js:403-414` filters the raw
  request array without deduping; a caller sending the same OWNED productId
  twice gets it iterated twice by `runConceptDrivenExpansion`
  (`campaignAdsGenerationService.js` ~3744), each iteration a paid Director +
  Judge round (~$0.105/round). Deterministic VIDEO is protected from the
  double-spend by its own `(campaignId, identityDigest)` unique index (digest
  omits `generationRunId`, so a same-SKU repeat collides and `insertMany`
  swallows the dup) — static is only *sometimes* protected, since its digest
  additionally includes `conceptId`, and two Director rounds on the same SKU
  can validly emit different concept slugs, in which case BOTH static sets
  insert and bill. Not fixed in this PR — a one-line dedupe in
  `resolveOwnedProductIds` (`routes/ads.js:403`, unique by `String(id)`,
  keep first) is the fix, tracked as follow-up.
- **#5** (legacy cartesian fallback has no brandId check) — **the "flag off"
  premise was wrong; this is latent, not live, and materially less urgent
  than first reported.** `AI_CONCEPT_DRIVEN` reads `false` from a bare
  `process.env` lookup when unset (`campaignAdsGenerationService.js:1469`),
  but `config/defaults.env:31` sets it to `true` and is loaded at boot after
  process env with no override (`index.js:1-5`) — so the EFFECTIVE default,
  live in prod, is `true`, meaning the concept-driven path runs and the
  legacy cartesian fallback (`seedsFromMedia`/`seedsFromProduct`, no
  `brandId` clause on either) is dead code on the default configuration.
  Worse, even if the flag were flipped off, the live concept-driven universe
  build already brand-scopes `mediaIds`
  (`services/seededUniverseService.js:451`, "safety — never leak media from
  other brands") — so #5 is only reachable if BOTH `AI_CONCEPT_DRIVEN=false`
  AND the request is image-only/single-format (no PMax/mixed formats). Real
  bug, correctly identified pattern, but latent behind two conditions, not a
  live default-config leak. Not fixed here — tracked as follow-up, lower
  priority than #3.
- **#6** (`/generate` persists unfiltered `mediaIds` onto
  `Campaign.mediaIds`) — **partially confirmed; the persistence is real, but
  the "keeps re-triggering cost on every subsequent generate" framing was
  wrong.** `routes/ads.js:813-819` does `$addToSet` the raw, unfiltered
  `mediaIds` — confirmed, and contrasts with the dedicated pin routes in
  `routes/campaigns.js` (~905-912, ~739-744), which DO brand-filter before
  the same `$addToSet`. But `expandWizardJob` never reads `Campaign.mediaIds`
  back — a later `/generate` only sees a persisted foreign id if the CLIENT
  re-posts it, and if it does, the live universe build (same
  `seededUniverseService.js:451` brandId clause as #5) drops it before it
  can become a billable seed. **What actually leaks today is read-back, not
  re-billing**: `GET /api/campaigns/:id/media` (`routes/campaigns.js:944`)
  does `Media.find({ _id: { $in: ids } })` with **no** `brandId` clause and
  returns `fileUrl` — so a foreign brand's pinned media genuinely gets
  served back to the operator's UI. That GET-route leak, not a re-billing
  loop, is the real, live consequence, and it's the more precise fix target.
  Not fixed here — tracked as follow-up.

## KNOWN-OPEN carried forward / updated

See `session.d/KNOWN-OPEN.md` — the entry for this review is updated in the
same commit to mark this finding (#1) FIXED and correct the #2/#3/#5/#6
severities to the above.
