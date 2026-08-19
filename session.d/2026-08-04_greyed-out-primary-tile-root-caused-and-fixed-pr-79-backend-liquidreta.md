## 2026-08-04 — GREYED-OUT "PRIMARY" TILE. Root-caused and fixed. PR #79 (backend) + liquidretail #33 (frontend)

Owner: the **PRIMARY** tile in the ad-generation image picker was greyed out and captioned
*"image still processing"* on a retailer ingested weeks earlier. **Nothing was processing.**

**Root cause.** The picker greys any tile whose `imageMediaId` is falsy; the thumbnail comes
from the raw `imageUrl`, hence "greyed but visible". `afbf288` (#7, 2026-07-23) moved
per-product detect behind `CATALOG_DETECT_PRECOMPUTE=false`, so **no ingest path** materializes
the hero at sync time — `enqueueBrandProductDetects` returns `deferred` before reaching
`enqueueProductDetect`. The compensating pull (`ensureDetectForProducts`) runs at
**ad-generation time, after the picker renders.** Alts escaped only because
`GET /api/catalog/:id` already lazily backfilled them; there was no hero equivalent.

**The generalisable lesson — `imageMediaId` means "a hero Media EXISTS", NOT "detect RAN".**
Conflating those two facts produced three separate defects, all fixed here:
1. `enqueueProductDetect` persisted the pointer from `enqueued.hero` (which additionally
   requires DetectRun creation, declined by `createDetectRunIfAbsent` on an
   E11000-with-no-in-flight-run race) → usable Media stamped `null`, made permanent by the
   skip gate.
2. `seedsFromProduct` + `expandDeterministicVideo` read only `enqueued.hero` → a
   materialized-but-unqueued hero became `NO_HERO_MEDIA`, a **silently dropped video ad**.
3. `ensureDetectForProducts` gated on the bare pointer → would have skipped every
   backfilled product, shipping **paid ads with no crops or overlay zones**. Now gates on
   the DetectRun.

**Fix.** `materializeMissingHero` (hero counterpart of `materializeMissingAlts`) on the same
endpoint, **materialize-only, no DetectRun** — one Cloudinary mirror, no Gemini. The deferral
is NOT reverted (`CATALOG_DETECT_PRECOMPUTE` stays `false`; the fence asserts it).
Pointer-only products route to the new `ensureDetectRunsForExistingMedia` (runs only, persists
nothing) — **never** back through `enqueueProductDetect`, which writes
`additionalImageMediaIds` **compact** while `materializeMissingAlts` keeps it
**index-aligned**; the detail response and alt crop galleries zip by index, so rewriting
mis-pairs every alt when a hero URL is duplicated into `additionalImages` (common feed shape).

**Fence:** `scripts/verifyCatalogHeroMaterialize.js` — 65 offline checks, revert-proven on 13
mutations. Suite 53 pass / 1 fail, identical to `origin/main` (`verifyFontFallback` fails on
trunk too).

⚠️ **Two of the three defects, and both regressions in my own drafts, were caught by the
adversarial review pass — not by reading the diff.** The pointer/run conflation is genuinely
easy to miss. Keep that pass mandatory here.

**Known limit, dormant:** under `CATALOG_DETECT_PRECOMPUTE=true`,
`enqueueBrandProductDetects` still skips on the bare pointer, so backfilled products wouldn't
eagerly precompute. Ad time guarantees correctness regardless; precompute is off.

**Owner follow-up — BUILT AND MERGED same day.** PR #83 (backend) + liquidretail #34 (frontend).
*"For video generation I always want the first, second and third catalog images as downloaded from
the website or their Shopify feed"* (front / side / back, though it varies), with the count AND the
type ENV-configurable for both rails. `services/referenceDefaultsService.js`; served via
`/api/ads/veo-prompt-scaffold` so `config/defaults.env` stays the single source of truth and no
Netlify rebuild is needed to change a number.

`VIDEO_DEFAULT_REFERENCE_COUNT=3`, `IMAGE_DEFAULT_REFERENCE_COUNT=1` (was hardcoded in the
frontend), plus `VIDEO_/IMAGE_DEFAULT_REFERENCE_SHOT_TYPES` — **both empty, and empty is a strict
no-op.** Owner asked directly whether there is a default shot type: **there is not, and there must
not be.** It is a PREFERENCE (stable reorder), never a filter, because `classification.shotType` is
written by the deferred detect pass — a filter would empty the stack for exactly the
freshly-ingested products being generated for. Rails stay independent: deriving static from video
re-opens the 3-image-static-universe bug (`universeTopN = max(mediaIds.length,
DIRECTOR_UNIVERSE_TOP_N)`).

Also surfaced `VIDEO_SEED_FEED_ORDER=true` and `VIDEO_SEED_MAX_SUBJECT_FRACTION=0.6` into
`defaults.env` — both were honoured in code but lived only in `.env.example`, so the sole way to
change them was the Render dashboard. Written at their existing effective values; **nearly shipped
0.55 from a misread**, so the fence now pins them against the code defaults. Do that check whenever
surfacing a code-only knob.

⚠️ **A SOURCE dial (catalog / catalog_then_ugc / any) was drafted and CUT before merge** — it was
dead in every wired path (picker rows come only from the catalog endpoint; applying it in
`buildReferenceImages` would have discarded deliberately-chosen lifestyle media). Don't re-add it
without wiring it. The fence asserts its absence. Same review also caught a second served video
count that could contradict the cascade, a resolver bound (12) looser than the model ceiling it
feeds (7), and an unguarded shot-type query that could 500 product detail.

Scope, so it isn't re-derived: the video preference applies to the picker AND
`buildReferenceImages` auto-assembly, does NOT move the seed at position 0, and never reorders an
explicit operator pick list. The static policy governs the **picker pre-pick only**; the backend's
empty-`mediaIds` fallback stays `DIRECTOR_UNIVERSE_TOP_N`. The picker needs per-image shot types or
the knob is inert (its explicit picks suppress the backend's assembly), so
`GET /api/catalog/:id` now returns `imageShotType` + `additionalImageShotTypes`, index-aligned and
hole-preserving.

Fence: `scripts/verifyReferenceDefaults.js` — 43 checks, revert-proven on 9 mutations. Suite 58/0.
