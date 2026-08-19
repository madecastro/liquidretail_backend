## Next-session prompt

**NEWEST — 2026-08-12: three fixes MERGED AND DEPLOYED (#179, #173, #176). Live on
web + worker at `7565b9bc`, boot logs clean. Verified live on staging with free
dry-runs. ONE VERIFICATION GAP remains — see the end of this block.**

All three came out of an owner report on a real Marine Layer run: *"despite choosing
just static ads for meta i got a video"*, *"none of the meta resizes appears to be
correct"*, *"repeating the same slogan in 3 different intent profiles isn't
acceptable"*, and *"I selected the super plan and it told me I would get 31 creatives
and I see 16"*.

### #179 — a static-only request no longer queues or claims video (MONEY)

Two independent causes, either sufficient alone:

1. **`campaign.adKinds` was consulted but NOTHING EVER SETS IT.**
   `models/Campaign.js` declares `adKinds: { default: 'both' }`; `Campaign.create()`
   omits it so Mongoose bakes `'both'` into every document, and `PATCH
   /api/campaigns/:id` does not accept the field. So
   `kinds || campaign.adKinds || 'image'` **never reached its `'image'` arm** — the
   intent stated in the comment above that line ("unset means the wizard didn't say")
   was correct and simply unreachable. All three live Meta STATIC surfaces are
   dual-kind, so `resolveKinds` returned `['image','video']` and queued a billable
   Omni submit (~$0.90-1.20/product). Now `kinds || 'image'`. The stored field is
   left in place deliberately — harmless once unread; migrating ~127 documents to fix
   a value nothing consults is motion without effect. **If it ever becomes
   operator-settable, re-introduce it in `requestedKinds` and pin the precedence.**
2. **`selectAdsForRun` was kind-blind and its tier 0 drains `renderRoute:'veo'`
   FIRST.** Kind scoping existed at EXPANSION time and nowhere at SELECTION time, so
   even a correct static-only expansion claimed leftover queued video for the same
   product from an earlier session — ahead of the statics, billing per row. Now an
   **opt-in** `kinds` filter via renderRoute. ⚠️ `POST /api/ads/runs` is deliberately
   left unnarrowed (it must drain every queued ad or rows strand) and a check pins
   that. ⚠️ The video tier is **GATED, not filtered** — it hardcodes
   `renderRoute:'veo'`, so spreading the filter would OVERWRITE that key and turn the
   video tier into a second static tier. The route passes the expansion's OWN
   `resolvedKinds`; re-deriving would drift from the derivation that decided what got
   queued (same trap `generationGate.js` documents for fingerprints).
   `scripts/verifyStaticOnlyNoVideo.js` — 21 checks, 4 mutations revert-proven,
   including the two SILENT ones (filtering instead of gating; the route reading a
   wrong variable name, which looks like a working filter and does nothing via the
   fail-open path — **this happened for real in development**, `expansion` vs `job`).

### #173 — Meta 1:1 / 4:5 / Reels restored as FREE derivations

Since **2026-08-01** a Meta video run delivered ONE ad; it used to deliver three.
`919627a0` collapsed Meta video to a single 9:16 master because each aspect was
minting its own Omni submit — three PAID masters per product. Correct money fix; its
message states the intent ("the other Meta video sizes are derivations of that
master (Phase 3)") and **the derivation half was never built**. Nine days later PMax
Phase A built exactly that mechanism for `pmax_video_1_1`. This ports it.

Everything downstream already existed: `basePlateCropService` head-anchored crop,
all four Remotion compositions, `renderDeriveOnlyVideoAd` (aspect-agnostic,
submit-free). Only the QUEUEING was missing.

- **Any Meta video tick now resolves to the MASTER** (both `resolveExplicitFormats`
  and legacy `single`). These surfaces are no longer independently generatable, so
  emitting a ticked 1:1 as the master would queue an ad that waits for a Stories
  plate nobody generated. It also closes a digest collision: a standalone billable
  `meta_reels_9_16` and a free derived one hash IDENTICALLY and collide on
  `(campaignId, identityDigest)` — one silently never inserts, decided by insert order.
- ⚠️ **The derive gate is NOT unconditional, and this is the one divergence from the
  PMax pattern.** `pmax_video_1_1` was never a legitimate master, so "this format ⇒
  free always" is safe there. Meta's 1:1/4:5/Reels WERE their own paid masters before
  `919627a0`, so historical rows exist that paid for their own plate and carry no
  marker. `resolveDeriveFromMaster` therefore fail-closes on platformFormat **only
  when the row has no `veoPredictionId`** (the spend receipt). Without that, a
  regenerate on a historical paid Meta video 409s and a re-render waits for a sibling
  that never existed. **Caught by adversarial review, not by the harness.**
- **Stories got its own safe zone.** `SAFE_ZONES.vertical` is, by its own header, the
  Meta REELS zone (bottom 35%). Stories rode on it too, which was wrong twice: Stories
  reserves ~14% (250/1778), and it made Stories and Reels render IDENTICALLY — so a
  Reels derivative would have been a duplicate ad. ⚠️ The 0.14 is **derived from our
  own `PLATFORM_FORMATS`, not a measured Meta template** (unlike the PMax 0.36, which
  was pixel-measured from Google's published PNG). Provenance is noted in the file.
- `PMAX_VIDEO_SAFE_ZONE_KEY` deliberately NOT renamed despite now holding a Meta
  entry — it is exported and referenced by name by the PMax work.
- Kill switch `META_VIDEO_DERIVATIVES` (default ON); flag-off byte-identical.
  `scripts/verifyMetaVideoDerive.js` — 52 checks, 5 mutations revert-proven.

### #176 — Director copy diversity (specs + ranked quote pool + per-style grounding)

Root cause of the repeated slogan, verified end to end: the prompt permits nulling
`copy.headline` on thin data (`:2358`); the variety rule was an **OR** copy needn't
satisfy (`:2219`) — and at `DIRECTOR_UNIVERSE_TOP_N=1` (default) the media-pick and
output_shape axes are structurally single-valued, so only archetype and style could
differ at all; `validateDirectorPayload`'s dedupe compared only NON-NULL headlines so
three nulls passed clean (`:1342`); and every null cascades to the SAME
`brand.tagline`.

- **`product_signal.specs`** — `CatalogProduct.specs` (Immersive specifications) was
  already in memory on every Director call (bare `findById().lean()`) and reached
  NOTHING in the ad pipeline. `normalizeProductSpecs` flattens the untrusted `Mixed`
  shape, caps at 8 rows, and drops object-valued labels AND values.
- **Quote pool 2 → 4 per tier, RANKED by `scoreQuote` desc.** Ranking is the
  load-bearing half: since #157 intake deliberately STORES generic praise, so
  `brandReviews.quotes` carries lines that clear the >30 filter and score 0. A wider
  first-N slice would have added filler.
  ⚠️ **Do NOT filter with `clearsQualityFloor`** — it requires the positive-praise
  lexicon screen, so a concrete implicit-endorsement quote scores 4.5 and still fails;
  and that screen was deliberately removed from this file's decision path, with
  `verifyQuoteGate` pinning its absence.
- **Per-style GROUNDING** rules; `brand_led` named as the last resort it already was.
  ⚠️ `social_proof_led` must use **PRODUCT tier** quotes only — brand/category quotes
  may describe a DIFFERENT SKU (which is why they are withheld from `primary_quote`),
  and the pre-existing scope rule only ever covered NUMBERS.
- Nulls now participate in the dedupe under a **Symbol** sentinel (a string sentinel
  is a headline the model could emit). One null still allowed.
- **`DIRECTOR_SIGNALS_VERSION` deliberately NOT bumped** — the live path
  `directConceptsRound` has no signalsVersion cache; a bump flushes nothing here and
  forces a paid re-derive of the shadow artifact.
- Quote ROTATION (#161) already exists in `directImageRenderService` — not duplicated.

### Verified live on staging (free dry-runs, zero spend)

| request | result |
|---|---|
| Meta static only, product-scoped | `total 3`, **videoMasters 0**, images 3 |
| Meta video, product-scoped | `total 7`, **videoMasters 1, freeDerived 6** |

⚠️ **A first video test was a FALSE NEGATIVE nearly reported as success:** run with
`productIds: []` it routes to the concept path (`deterministic: 0`) and returns
`total: 1`, never touching the derive branch. **Product-scope any test of the
derivations.**

### THE REMAINING VERIFICATION GAP — do this first

**No real generation has rendered a Meta derivative.** The dry-run proves the
queueing math, NOT that the crop and titling come out right on a derived 1:1 or 4:5
plate. Needs ONE billable Meta video run on a single product (~$0.90-1.20), then
probe the delivered files with ffprobe/ffmpeg and LOOK at frames — the method that
found the real defects earlier (see the delivered-ad findings section above).

### Also still open (diagnosed, untouched — quote honesty, not spend)

- **`MAX_CREATIVES_PER_RUN = 20`** (`services/concurrency.js:49`) is applied at claim
  time in `selectAdsForRun` and is **structurally invisible** to the quote:
  `campaignAdsGenerationService` never imports `concurrency.js`. Any quote above 20 is
  silently truncated — this is the 31 → 20 half of "told me 31, I see 16".
- **The concept-driven dry run is fixed-yield arithmetic** —
  `min(3, ADS_PER_PRODUCT_CAP) * staticFanoutCount` per product, with no seeded
  universe, no Director call, no media check. A product whose round fails contributes
  zero while quoted full. That is the 20 → 16 half. Nothing reconciles quoted vs
  actual: `CampaignRun.total` is written AFTER truncation.

### Cross-session coordination (this was load-bearing, keep doing it)

Two other sessions were live in the same files. `send_message` prevented two real
clobbers: a rename of `PMAX_VIDEO_SAFE_ZONE_KEY` they had just exported, and
duplicated work on copy diversity. Agreed split — **they own SELECTION + RENDER**
(`videoHeadlineService` funnel-stage ordering, `brandScriptExecutor`,
`slotContent` `TEXT_CHAR_CAP`, Remotion presets, and the `pmax_video_9_16`
double-title, which is **their PR #174** — a `${phase}|${anchor}` layout overlap, NOT
a re-titled video); **we own GENERATION** (Director brief/prompt, the Meta derive map,
`platformFormats`).

⚠️ **`main` moves several times an hour with parallel sessions.** A `gh pr merge`
failing with *"Pull Request is not mergeable"* is usually that race, not a conflict —
rebase onto the new tip, **re-run the suite** (do not assume the earlier pass holds),
and merge immediately. Suite was 116-117 harnesses green through all three merges;
`verifyLogoSilhouette` fails ONLY in throwaway worktrees (native `sharp` does not
resolve there — it is present in the real checkout).

---

**2026-08-11 — mixed Meta+PMax video was silently dropping the Meta master. FIXED, MERGED (#145), on `main`.**

The wizard offers "All video" per platform and they are combinable, so ticking both is the
advertised flow. `resolveDeterministicVideoMasterFormats` did
`if (googleMasters.length) return googleMasters` — so ANY Google master discarded the Meta one.
A mixed run billed 2 Omni submits, produced **zero Meta video**, and the wizard quoted 3.
Now partitions per platform. Behaviour: Meta-only 1 master; PMax-only 2 + free 1:1;
mixed 3 + free 1:1; PMax-16:9-only 1 and NO free square (the crop needs the 9:16).

**Three things worth knowing before touching this again:**

1. **`isGoogleVideoMasterRun` no longer requires every master to be Google** — only that the
   crop's source (`pmax_video_9_16`) is present. Widening it is safe (deriving never calls
   Omni) but it opened a second hole: the funnel-variant mint looped over ALL `masterFormats`
   inside the googleRun branch and began minting Meta funnel rows. Those are not merely
   wasteful — `funnelStage` is not part of a Meta identity digest so they collapse onto the
   Meta master and get swallowed, BUT `resolveDeriveFromMaster` returns null for a Meta
   platformFormat even with a stage set, so any that DID insert would take the **billable**
   path. Loop and dry-run count are both scoped to Google masters now.
2. **The whole 103-script suite passed both before and after the original bug.** Nothing pinned
   the mixed case. `scripts/verifyMixedPlatformVideo.js` (24 checks) now does, revert-proven
   against six mutations. Note mutation 3 (removing ONE of the two overlapping derive-only
   guards) passes by design — that is recorded in the harness header rather than hidden.
3. **`verifyPmaxFunnelVariants` M1 is a source-PROXIMITY check** (200 chars between
   `isPmaxFunnelVariantsEnabled()` and `PMAX_FUNNEL_STAGES.length`). A comment wedged between
   them fails it. Keep explanatory prose above the gate, not inside it.

**`formatEntry()` now publishes `safeAreaPct`** (fractions of frame height) so the ad-preview
chrome draws its guardrail from the real clamp. NORMALISED on purpose: raw `safeArea` is
CANVAS-space (width-normalised to 1000), not `deliveryDims` — `pmax_video_16_9` is 20% of its
canvas vs 10.5% of delivery. Publishing raw pixels without `canvas` hands every consumer that
trap. Frontend counterpart merged as `liquidretail#44`.

Full suite **106/106** on merged `main` (composes with the lifestyle-preserve work in #144,
which landed in the same window).

---

