## 2026-08-05 — CATALOG IMAGE ORDER IS THE MERCHANT FEED'S ORDER. UNCOMMITTED, NOT DEPLOYED

Owner directive, verbatim: *"we need to use the ordering as it exists in the data feed and
establish the nomenclature at ingest, the primary image as defined by the merchant feed is the
main image that should be used for static, and the first image for video, the second and third
image for video should be the first and second other images in the feed, as they appear in the
feed, in the order they are in the feed. Likewise any time you display catalog images they should
be shown in feed order, primary first, then the alts. The Hero stamp is not relevant when
selecting images for video or static catalog generations."*

**This SUPERSEDES the 2026-08-03 "first image that came from the catalog" rule and the
2026-08-04 tier-2 shotType-rank amendment.** Both are described elsewhere in this file and in
CLAUDE.md §2 / §4; those descriptions are now historical.

**What was measured first, and it justified the directive.** Pulled the three real Gymshark
"Campus Crest Zip Through Hoodie" colorways from prod. On BOTH SKUs that have media, the `hero`
Media doc was materialised **AFTER** all four alts (Black: +1h41m; Heavy Blue: +8s). The video
rail sorted `createdAt asc` and its own comment claimed *"hero materializes before alts, so
createdAt asc ≈ hero-first"* — **false on real data**. So the live video reference stack for
those products was **three alts, hero not in the stack at all**. That is the defect this fixes.

**Nomenclature at ingest: `Media.metadata.feedIndex`.** `catalogProductDetectService`
stamps `0` for `product.imageUrl` and `1..N` for `additionalImages` in feed order
(`materializeImage` gained a `feedIndex` param; `enqueueProductDetect` and
`materializeMissingAlts` both pass it, and the existing-doc fast path backfills it).

**Selection is a two-tier cascade, POINTER BEFORE STAMP — the order is money-critical.**
1. `CatalogProduct.imageMediaId` — the LIVE pointer, rewritten on every (re-)detect.
2. `metadata.feedIndex === 0` — the ingest stamp, when the pointer is absent (non-primary
   variant, detect never completed).
3. (static only) best shotType-ranked catalog image.

`feedIndex` is **denormalised and nothing clears it**: when a merchant replaces their primary
image, re-detect materialises a NEW Media under a new externalId and the RETIRED image keeps
`feedIndex:0` forever. A stamp-first cascade seeds a billable Omni render from a photo the
merchant has replaced. **Both orders were implemented; this one is correct.** Pinned by
`verifyCatalogFeedOrderSeeding.js` S7/V2d.

**Because tier 1 needs no stamp, this is CORRECT ON EXISTING DATA with the backfill unrun.**
That was not true of the first draft — see the blocker below.

**Video reference order:** `atlasVideoService.sortCatalogMediasForReferenceStack` orders the
catalog pool by `feedIndex` asc (unstamped sorts last, tiebreak createdAt). The query's
`.sort({createdAt:1})` is gone. Seed=feed0 → refs feed1, feed2 under the 3-ref default.
**This ordering reads `feedIndex` ONLY**, so refs 1/2 stay in legacy order until the backfill
runs — that is what the backfill actually unlocks, not the seed.

**Subject-dominance guard on the video seed is REMOVED** (`VIDEO_SEED_MAX_SUBJECT_FRACTION` is
now dead on the flag-on path). Owner chose strict feed order, no exceptions, when asked
directly. The face-crop risk it mitigated returns by design.

**Kill switch `CATALOG_FEED_ORDER_SEEDING`** (`config/defaults.env`, default true) reverts all
of it. **Scope is the two LIVE DEFAULT paths only** — concept-driven static and deterministic
video. `adRegenerateService` (static regenerate) and `seedsFromProduct` (legacy, off by default)
were deliberately NOT changed; owner scoped it that way.

### THE BLOCKER THAT ADVERSARIAL REVIEW CAUGHT — do not reintroduce it

The first draft made `firstCatalogMediaForProduct` return **null** when no media carried
`feedIndex:0`, on the assumption the caller's lazy-materialize path would self-heal. **It cannot.**
`enqueueProductDetect` early-returns `{skipped:true}` whenever `imageMediaId` is already set
(`catalogProductDetectService.js:44-46`) — which is every already-detected product — so
`enqueued.hero` is undefined and `expandDeterministicVideo` skips with `NO_HERO_MEDIA`. That is
**ZERO video ads for the entire existing catalog** until the backfill ran: an outage, not a
degradation. Fixed by the `imageMediaId` tier above. Pinned by `verifyCatalogFeedOrderSeeding.js`
**V2** — if that test ever expects `null` again, the outage is back.

Two more from the same review, both fixed: the backfill's `$exists:false` filter skipped docs
whose `feedIndex` key existed but was **null** (permanently stuck — unstampable AND unselectable;
now `$not:{$type:'number'}`), and `materializeMissingAlts` numbered alts by **raw array index**
while `enqueueProductDetect` filtered hero-duplicates first, so the two writers disagreed about
the same image's feed position (both compact now, and the backfill matches).

### Files + verification

- `services/catalogProductDetectService.js` — feedIndex stamping, compact alt numbering.
- `services/seededUniverseService.js` — `promoteFirstCatalogImage` cascade + `primaryMediaId` opt.
- `services/campaignAdsGenerationService.js` — `firstCatalogMediaForProduct` cascade.
- `services/atlasVideoService.js` — `sortCatalogMediasForReferenceStack`.
- `config/defaults.env` — `CATALOG_FEED_ORDER_SEEDING`.
- **NEW** `scripts/backfillMediaFeedIndex.js` — **NOT RUN YET** (`--dry-run` / `--brand` supported).
- **NEW** `scripts/verifyCatalogFeedOrderSeeding.js` — S/V/R/I groups, **7 revert-proven mutations**.
- `scripts/verifySeededUniverseHeroDefault.js` now force-sets the flag **off** at its own top, so
  its 122 checks keep pinning the legacy cascade byte-for-byte.
- Full offline suite: **55 scripts, 0 failing.**

### Still to do

1. **No live render yet.** Nothing here has produced a real ad.
2. **Run the backfill** (`--dry-run` first) — needed for video refs 1/2 to be in feed order.
   Not needed for the seed. Requires owner go-ahead: it writes to prod Media.
3. **Frontend display order was NOT audited** beyond confirming `routes/catalog.js` returns
   `imageUrl` + `additionalImages` in feed order. The owner's "any time you display catalog
   images" clause may need a pass over `CatalogBrowser/ImageGallery.tsx` and `Step2Picker.tsx`.
4. `config/defaults.env` in this working tree ALSO carries another session's uncommitted
   fidelity-hardening block — **stage hunks, never `git add` the whole file.**

---

