## 2026-08-20 — mediaAssignmentService cross-brand attach hole closed, PR #271

Confirmed and closed the same class of tenant-isolation gap PR #245 and #257 already
fixed on sibling paths, this time in `services/mediaAssignmentService.js`.

**The bug:** `attachProduct` / `attachCategory` / `attachPromotional` scoped their
ownership asserts (`assertProductOwned`, `assertCategoryOwned`) to
`{ _id, advertiserId }` only — never `brandId`. One advertiser can own many brands
(`models/Brand.js`'s unique index is `{advertiserId, nameNormalized}`, not
`{advertiserId}` alone), so an operator — or the `media.attachTo` agent capability,
which never reads a brandId arg either — could attach a same-advertiser,
**different-brand** `CatalogProduct`/`Category` onto a Media row. Produces a
same-brand Media with a cross-brand `matchedProducts[].catalogProductId`, exactly the
shape PR #245/#257 defend against elsewhere. The file's own header claimed
"cross-tenant attach is impossible" — true only for advertiser tenancy, false for
brand tenancy.

**Reachability — confirmed LIVE, not theoretical** (Grok `--effort xhigh` trace,
independently spot-checked against the real source): `POST /api/media/:mediaId/assign`
and the `media.attachTo` agent tool both authenticate via `req.advertiserId` only.
There is no `req.brandId` anywhere in this codebase — confirmed by grep, not
assumption — and `capabilityRegistry.js`'s `scope: 'brand'` on these capability
entries (`media.attachTo` / `media.detachFrom` / `media.listAssignments`) is pure
documentation, never enforced at dispatch (`applicableCapabilities` is exported with
zero production callers). A brand-switch + a single `POST /assign` (or the
equivalent agent call) reaches this today.

**The fix** (`services/mediaAssignmentService.js`):
- `assertProductOwned`/`assertCategoryOwned` now take the Media row's own `brandId`
  and FAIL CLOSED — `if (!brandId) return null` before any query — same idiom as
  `catalogProductDetectService.ensureDetectForProducts` (#257).
- `attachProduct`/`attachCategory`/`attachPromotional` refuse with a distinct
  `MEDIA_BRAND_UNDETERMINABLE` (400, not the 404 `MEDIA_NOT_FOUND` gets) when the
  Media row has no `brandId` (legacy media predates brand tagging), instead of
  falling back to an advertiser-only check.
- `attachProduct`'s `CatalogProduct` mirror writes now repeat
  `{ advertiserId, brandId: media.brandId }` (TOCTOU defense in depth).
- `detachProduct`'s inverse write previously had **no tenant filter at all**
  (`{ _id: oid }`) — now `advertiserId` always, `brandId` when known.
- `listAssignments` hydration now scopes by `brandId` when available, mirroring the
  sibling `GET /:mediaId/related-products` route already in `routes/media.js`.
- Corrected the false header claim.

Forward-only — no historical-row remediation. `attachBranding`/`detachBranding`/
`detachCategory`/`detachPromotional` are Media-only ops with no second brand-owned
resource and are unaffected (checked, not assumed).

**Verification:** new `scripts/verifyMediaAssignmentBrandTenancy.js`, same convention
as `scripts/verifyGenerateProductTenancy.js` / `scripts/verifyDetectPrepMediaTenancy.js`
— real exported functions driven against faithful Media/CatalogProduct/Category
stubs monkey-patched on the real required model objects. **Revert-proved by actually
reverting**: swapped in the pre-fix source, confirmed exactly the checks that assert
the fix's behavior went red (6 passed / 11 failed), restored, reran green (17/17),
`git diff` confirmed a byte-identical restore. One candidate revert-prove mutation
(dropping the *outer* `MEDIA_BRAND_UNDETERMINABLE` guard) turned out to have NO
security effect — `assertProductOwned`'s own fail-closed check is a redundant deeper
gate — so it is documented as a structural finding instead of asserted as a
revert-prove, deliberately avoiding PR #257's B2 mistake (a check that required the
insecure outcome to pass).

`npm test`: 179/179 (includes the new harness). `npm run lint`: clean.

**Process:** reachability trace and an initial fix draft came from Grok CLI
(`grok-4.6`, `--effort xhigh`, read-only sandbox, run as three separate focused
calls, not one giant prompt) per standing instruction to push analysis/drafting to
Grok. The applied fix, the harness, and the revert-proof were written and verified
directly against the real source here — Grok's write sandbox is classifier-blocked
and cannot apply its own drafts. An adversarial Grok xhigh review of the final diff
was still running when this entry was written; see the PR (#271) for its findings
and any follow-up.

**PR:** #271, branch `fix/media-assignment-brand-tenancy`, off `main` @ `d9c7dd0d`.
Not self-merged — owner reviews money/tenant diffs line-by-line.

**Not in scope, flagged separately:** `services/campaignAdsGenerationService.js`'s
`seedsFromMedia` loads `Media.findById(mediaId)` with no `brandId` filter and can
consume a cross-brand `matchedProducts` entry (whether from before this fix, or any
other write path) into ad generation — same blast-radius class as #245/#257. Spawned
as a follow-up task chip rather than fixed here (different file/service, and this
session's lane was explicitly `services/mediaAssignmentService.js` to avoid
overlapping two other live sessions touching `routes/ads.js`-adjacent code the same
night).
