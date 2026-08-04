// Seeded media universe builder (Phase A — concept-driven generation).
//
// For one (brandId, productId) pair, returns the prioritized set of
// related media the Director will reason over when emitting concepts.
// One Director call per product per format consumes this; concepts then
// declare which subset of the universe they actually use.
//
// Ranking model: catalog and UGC are merged into a SINGLE pool and
// ranked by classification.shotType (lifestyle → on_model → flat_lay →
// product_only → detail → packaging → unknown). Source is preserved
// as a role tag on each entry (catalog / ugc_product_match /
// ugc_product_category / ugc_brand_match) for downstream diagnostics
// and director-side provenance, but does NOT gate order. A UGC
// lifestyle post ranks equal to a catalog lifestyle shot.
//
// Within a shot-type tier, tiebreaks in order:
//   1. burned-text penalty (only when wantsVideo — Grok bakes any
//      captions / stickers / watermarks into the generated video)
//   2. imageRole='hero'          — merchant's primary listing (catalog only)
//   3. platformStats.engagement  — likes + comments signal (UGC only)
//   4. createdAt desc            — recency
//
// THE DEFAULT IMAGE SEED IS NOT THE RANKING. Owner rule, 2026-08-03,
// verbatim: "I actually just want to use the first image that comes from
// the catalog not the 'hero' image since that may also come from social
// media or UGC?" So the default seed for a catalog image gen is THE FIRST
// IMAGE THAT CAME FROM THE CATALOG, and it can never resolve to a UGC
// post. Read the tiebreak list above literally — imageRole='hero' is key
// #2 *within* a shot-type tier, so a catalog lifestyle ALT (or a UGC
// lifestyle post) outranks a product_only catalog image outright.
// Trimming to DIRECTOR_UNIVERSE_TOP_N=1 therefore does not even
// guarantee a catalog image; it yields the best lifestyle candidate,
// which is how a UGC post reached a catalog product ad.
// `opts.preferFirstCatalogImage` (default FALSE, so no existing caller
// changes) is what implements the rule: promoteFirstCatalogImage() hoists
// the first CATALOG-SOURCED entry to index 0 AFTER ranking and BEFORE the
// top-N trim, via a cascade — role==='catalog' + imageRole==='hero' (the
// catalog feed's first image), else the earliest-createdAt catalog entry,
// else nothing. It is deliberately skipped for operator picks
// (restrictToMediaIds IS the override) and for brand-only runs (every
// SKU's catalog media is pooled, so "the catalog's first image" is
// undefined).
//
// UGC tier 2 (product_category) and tier 3 (brand_match) are still
// opt-in via `includeCategoryMatched` / `includeBrandMatched` flags,
// and still have their cross-product guards (tier 2 drops different-SKU
// posts, tier 3 drops any product-visible posts). Once eligible, they
// join the merged pool and compete on shotType alongside catalog.
//
// `seedUniverseHash` is sha256 of the top-5 mediaIds joined. It's
// surfaced for diagnostics ("seed universe drifted since last round")
// — NOT part of the Director cache key.

const crypto   = require('crypto');
const mongoose = require('mongoose');

const Media                = require('../models/Media');
const CatalogProduct       = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const { SHOT_TYPE_RANK: CATALOG_SHOT_RANK } = require('./shotTypeRank');

const DEFAULT_TOP_N = 10;

// Content-nature gate — same threshold as campaignAdsGenerationService.
// Drops time-bound posts (promotional / announcement) above 0.7
// classifier confidence; evergreen and unknown always pass.
const CONTENT_NATURE_BLOCK_THRESHOLD = 0.7;
function isContentNatureEligible(media) {
  const nature = media?.classification?.contentNature;
  if (!nature || nature === 'evergreen' || nature === 'unknown') return true;
  const conf = media?.classification?.contentNatureConfidence;
  if (typeof conf === 'number' && conf >= CONTENT_NATURE_BLOCK_THRESHOLD) return false;
  return true;
}

// Cross-product mismatch guards — same as the legacy expansion. Tier 2
// pairings that visibly show a different SKU get dropped; Tier 3 (brand)
// pairings that show ANY identified or unidentified product get dropped.
function hasIdentifiedSpecificProduct(media) {
  return Array.isArray(media?.matchedProducts) && media.matchedProducts.some(
    mp => mp && mp.outcome === 'product_match' && mp.catalogProductId
  );
}
function hasVisibleUnmatchedProduct(media) {
  if (!Array.isArray(media?.refinedProducts) || media.refinedProducts.length === 0) return false;
  return !hasIdentifiedSpecificProduct(media);
}

function hasBurnedText(media) {
  return Array.isArray(media?.text) && media.text.length > 0;
}

// Rank a merged pool of catalog + UGC candidates by shotType, with
// role-aware tiebreaks. Entries are wrapped { media, role } so we can
// preserve source provenance without gating order on it.
function rankMergedPool(entries, { wantsVideo = false } = {}) {
  return entries.slice().sort((a, b) => {
    const ra = CATALOG_SHOT_RANK[a.media.classification?.shotType] ?? CATALOG_SHOT_RANK.unknown;
    const rb = CATALOG_SHOT_RANK[b.media.classification?.shotType] ?? CATALOG_SHOT_RANK.unknown;
    if (ra !== rb) return ra - rb;

    if (wantsVideo) {
      const ta = hasBurnedText(a.media) ? 1 : 0;
      const tb = hasBurnedText(b.media) ? 1 : 0;
      if (ta !== tb) return ta - tb;
    }

    const ahero = a.media.metadata?.imageRole === 'hero' ? 0 : 1;
    const bhero = b.media.metadata?.imageRole === 'hero' ? 0 : 1;
    if (ahero !== bhero) return ahero - bhero;

    const ae = a.media.platformStats?.engagement ?? -1;
    const be = b.media.platformStats?.engagement ?? -1;
    if (ae !== be) return be - ae;

    const at = a.media.createdAt ? new Date(a.media.createdAt).getTime() : 0;
    const bt = b.media.createdAt ? new Date(b.media.createdAt).getTime() : 0;
    return bt - at;
  });
}

// Hoist THE FIRST IMAGE THAT CAME FROM THE CATALOG to the front of an
// already-ranked pool. PURE: returns a NEW array, never mutates the input.
//
// Owner rule, 2026-08-03, verbatim: "I actually just want to use the first
// image that comes from the catalog not the 'hero' image since that may also
// come from social media or UGC?"
//
// THE CASCADE — first tier that matches wins, and EVERY tier can only ever
// select an entry whose role is 'catalog':
//   TIER 1  the first entry with role === 'catalog' AND
//           media.metadata.imageRole === 'hero'. That stamp is written in
//           exactly one place: catalogProductDetectService materialises
//           CatalogProduct.imageUrl — the catalog feed's FIRST image — with
//           imageRole:'hero' (`:60`), and additionalImages[] with 'alt'
//           (`:80`, `:513`). So tier 1 IS "the first image from the catalog",
//           wearing a legacy name.
//   TIER 2  else, among role === 'catalog' entries, the one with the EARLIEST
//           media.createdAt. Catalog Media rows are materialised in feed
//           order, so earliest ≈ first. Ties — equal timestamps, or none
//           usable — resolve to the earlier entry in the incoming RANKED
//           order, so the outcome is deterministic and the ranker still
//           breaks the tie. An entry with a missing / unparseable createdAt
//           sorts LAST, never first: a legacy row with no timestamp must not
//           win "earliest" by defaulting to epoch 0.
//   TIER 3  else there is no catalog entry in the pool at all → an unchanged
//           copy. There is nothing from the catalog to pin.
//
// WHY TIER 2 EXISTS — this is the point of the rule, not a nicety. The pool
// this runs on is a SINGLE merged pool of catalog media AND product_match UGC
// (rankMergedPool deliberately does not let source gate order, so a UGC
// lifestyle post ranks equal to a catalog lifestyle shot). Tier 1 on its own
// is not enough because the imageRole stamp can be ABSENT — hero
// materialisation failed, or the row predates the stamp. A tier-1-only helper
// returned the pool unchanged in that case, and the shotType ranking then
// decided index 0 out of that merged pool — which is exactly how a UGC post
// became the default seed of a catalog product ad. The FALLTHROUGH is the
// failure mode; tier 2 removes it, so an UNSTAMPED catalog set still beats
// UGC.
//
// The `entry.role === 'catalog'` test is LOAD-BEARING IN EVERY TIER, not
// defensive. It is what makes "can never resolve to UGC" true rather than
// hopeful: metadata.imageRole lives on UGC docs too (we do not author
// creator-side metadata and do not control what it says), so a creator post
// stamped imageRole='hero' must still lose tier 1 to an unstamped catalog
// image via tier 2, and must never be selectable by tier 2 either.
//
// Stable: every non-promoted entry keeps its relative order, so the
// shotType ranking still decides positions 1..n (which matter as soon as
// DIRECTOR_UNIVERSE_TOP_N is raised above 1).
//
// MIRRORS the proven cascade on the deterministic VIDEO seed path,
// campaignAdsGenerationService.js:2085 ("Feed-order hero: imageRole hero →
// earliest createdAt → lazy materialize") — same tier 1, same tier 2. That
// rail's third step lazily materialises Media from CatalogProduct.imageUrl,
// which is a DB write and cannot live in a pure ranking helper; here tier 3
// is "leave the pool alone".
function promoteFirstCatalogImage(rankedEntries) {
  if (!Array.isArray(rankedEntries)) return [];
  if (rankedEntries.length < 2) return rankedEntries.slice();

  // The only membership test in this function. Nothing that fails this can be
  // selected by any tier.
  //
  // role==='catalog' means source==='catalog-product' — which is NOT the same as
  // "is an image". Catalog VIDEOS live under that same source: shopifyPublic-
  // IngestService upserts { source:'catalog-product', fileType:'video',
  // metadata:{ imageRole:'video', catalogProductId } } (:513-546), and the pool
  // query applies no fileType filter. Tier 1 was safe by accident (it demands
  // imageRole==='hero'), but tier 2 selects on createdAt alone, so a product
  // whose images are unstamped and whose catalog carries a video could hand a
  // VIDEO to a STATIC image generation as "the first catalog image".
  //
  // Excluding an EXPLICIT video rather than requiring fileType==='image' is
  // deliberate: a legacy row with a null/absent fileType must still satisfy
  // tier 2, because the alternative is falling through to tier 3, where the
  // shotType ranking can hand index 0 to a UGC post — the exact bug this
  // function exists to prevent. Both signals are checked because either one
  // alone identifies a video in the data we actually have.
  const isCatalog = (e) =>
    !!e
    && e.role === 'catalog'
    && e.media?.fileType !== 'video'
    && e.media?.metadata?.imageRole !== 'video';
  // NOTE: tier 2 used to sort on createdAt. It no longer does — see the tier 2
  // comment below for why feed order starved the Director.

  // TIER 1 — the catalog feed's first image, as stamped at materialisation.
  let idx = rankedEntries.findIndex(
    (e) => isCatalog(e) && e.media?.metadata?.imageRole === 'hero'
  );

  // TIER 2 — no hero stamp anywhere in the catalog set: the BEST-RANKED
  // catalog image wins. `rankedEntries` arrives already sorted by
  // rankMergedPool (shotType first: lifestyle > on_model > flat_lay >
  // product_only > detail > packaging, with the hero stamp as a within-tier
  // tiebreak), so the first catalog entry in that order IS the best-ranked
  // one. No separate sort is needed or wanted.
  //
  // WHY THIS CHANGED (2026-08-04, owner-directed). Tier 2 used to take the
  // earliest-`createdAt` catalog entry — the catalog feed's first image. That
  // is FEED ORDER, not quality, and it is routinely a bare packshot on white.
  // With DIRECTOR_UNIVERSE_TOP_N=1 that single packshot became the Director's
  // ENTIRE universe, and on SKUs whose description and reviews are empty the
  // brief got thin enough that the model stopped emitting concepts and started
  // asking clarifying questions instead ("I don't have enough information…").
  // Measured: 51 concept rounds / 0 failures on 2026-08-03 (before the
  // catalog-first cascade shipped) vs 10 failures / 11 rounds on 2026-08-04
  // (after). Ranking within the catalog set fixes the starvation without
  // giving up either guarantee that matters:
  //   - still exactly ONE primary seed (owner: keep the single seed);
  //   - still catalog-ONLY, because `isCatalog` gates every tier, so a UGC or
  //     social post can never win index 0 — the whole point of the cascade.
  // Tier 1 (the explicit hero stamp) is untouched and still wins outright.
  if (idx < 0) {
    idx = rankedEntries.findIndex(isCatalog);
  }

  // TIER 3 (idx === -1) — no catalog entry at all. Also covers "already
  // first" (idx === 0), where there is nothing to move.
  if (idx <= 0) return rankedEntries.slice();
  const out = rankedEntries.slice();
  const [firstCatalogImage] = out.splice(idx, 1);
  out.unshift(firstCatalogImage);
  return out;
}

function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
}

// Project a Media doc into the compact universe entry shape the
// Director consumes. role is set by the caller (catalog_hero, etc.).
// `url` is Media.fileUrl (our Cloudinary mirror — the canonical asset
// URL across the pipeline). The Director prompt builder owns any
// q_auto:eco / resize transform for vision-token reduction.
function projectEntry(media, role) {
  const out = {
    mediaId:   String(media._id),
    url:       media.fileUrl || null,
    fileType:  media.fileType || null,
    role,
    metadata:  {}
  };
  if (role === 'catalog' || role === 'catalog_hero' || role === 'catalog_alt') {
    out.metadata.imageRole = media.metadata?.imageRole || null;
    out.metadata.shotType  = media.classification?.shotType || null;
  } else {
    // UGC variants — creator info lives under media.metadata
    // (creatorName, creatorHandle, accountId, etc.). Engagement comes
    // off platformStats. Both surfaced compactly for the Director.
    const handle = media.metadata?.creatorHandle || null;
    const name   = media.metadata?.creatorName   || null;
    if (handle || name) {
      out.metadata.creator = {
        handle:   handle,
        name:     name,
        platform: media.source || null   // 'instagram' | 'tiktok' | ...
      };
    }
    if (media.platformStats) {
      out.metadata.engagement = {
        likes:    media.platformStats.likes      ?? null,
        comments: media.platformStats.comments   ?? null,
        views:    media.platformStats.views      ?? null,
        total:    media.platformStats.engagement ?? null
      };
    }
  }
  return out;
}

// sha256 of the top-N mediaIds joined with '|'. Stable per universe
// composition — adding a new UGC match that ranks below the top-N
// does NOT change the hash; promoting one into the top does.
function computeSeedUniverseHash(universe, n = 5) {
  const ids = universe.slice(0, n).map(e => e.mediaId).join('|');
  return crypto.createHash('sha256').update(ids).digest('hex');
}

// ── Public API ──────────────────────────────────────────────────────

// Returns { universe: [...entries], seedUniverseHash, counts }.
// `counts` breaks down the universe by role for diagnostics:
//   { catalog_hero, catalog_alt, ugc_product_match,
//     ugc_product_category, ugc_brand_match }
//
// brandId is required. productId is OPTIONAL — pass null for brand-only
// runs (brand campaigns with no specific SKU to anchor on).
//
// Product mode (productId set): tiers 1/2 from CatalogProduct.matchedMedia,
// tier 3 from brand-scoped ProductMatchArtifact when includeBrandMatched.
// Catalog pool is scoped to the specific product via metadata.catalogProductId.
//
// Brand mode (productId null): tiers 1/2 skipped (they're product-specific).
// Tier 3 (brand_match UGC) always fires regardless of includeBrandMatched —
// brand-only runs need brand-scoped UGC as the primary UGC source. Catalog
// pool expands to ALL catalog media for the brand (rank by shotType then
// takes top-N via topN); lifestyle-first ranking naturally surfaces the
// most brand-appropriate assets first.
async function buildSeededUniverse(brandId, productId, opts = {}) {
  if (!brandId) throw new Error('brandId required');
  const isBrandOnly = !productId;

  const topN = opts.topN ?? DEFAULT_TOP_N;
  const includeCategoryMatched = opts.includeCategoryMatched === true;
  const includeBrandMatched    = opts.includeBrandMatched    === true;
  // wantsVideo activates the burned-text penalty in rankMergedPool —
  // captions / stickers / watermarks push a candidate below text-free
  // peers within its shot-type tier when Grok image-to-video is next.
  const wantsVideo = opts.wantsVideo === true;
  // restrictToMediaIds — non-empty array switches to "operator picked
  // these specific seeds" mode. Universe pool is loaded from those
  // media IDs directly, bypassing the tier-based assembly. Preserves
  // shotType ranking but the pool is constrained to what the operator
  // explicitly chose in the wizard.
  const restrictToMediaIds = Array.isArray(opts.restrictToMediaIds) && opts.restrictToMediaIds.length
    ? opts.restrictToMediaIds.map(String)
    : null;
  // preferFirstCatalogImage — opt-in implementation of the owner's
  // default-image-seed rule, "the first image that came from the catalog"
  // (see the file header). DEFAULT FALSE on purpose: every caller that does
  // not ask for it gets byte-identical behaviour to before this option
  // existed, so the diagnostic script and any future caller are unaffected.
  // Only the concept-driven IMAGE path opts in
  // (campaignAdsGenerationService.runConceptDrivenExpansion).
  const preferFirstCatalogImage = opts.preferFirstCatalogImage === true;

  const counts = {
    catalog: 0,
    // Legacy keys kept zeroed for any caller that still reads them.
    catalog_hero: 0, catalog_alt: 0,
    ugc_product_match: 0, ugc_product_category: 0, ugc_brand_match: 0
  };

  // ── Operator-picked media mode ─────────────────────────────────
  // When restrictToMediaIds is set, the operator explicitly picked
  // specific seeds in the wizard. Skip the full tier-based assembly
  // and load only those media docs. Role tagging comes from
  // Media.source (catalog-product → 'catalog'; anything else →
  // 'ugc_brand_match' as a safe default — the exact UGC tier only
  // matters for downstream match-tier accounting, not for the
  // Director's picks).
  //
  // This branch deliberately never applies preferFirstCatalogImage. An
  // explicit pick list IS the "unless the user overrides it" half of the
  // owner rule; hoisting our idea of the catalog's first image to the front
  // would override the override.
  if (restrictToMediaIds) {
    const oids = restrictToMediaIds
      .map(id => toObjectId(id))
      .filter(Boolean);
    const pickedMedias = oids.length ? await Media.find({
      _id: { $in: oids },
      brandId  // safety — never leak media from other brands
    }).select('_id fileType fileUrl source createdAt classification metadata platformStats matchedProducts refinedProducts text').lean() : [];

    // Scope the operator's picks to the product being iterated.
    //
    // Without this, a multi-product run hands EVERY product's Director round
    // the SAME picked media — so a t-shirt's round sees another SKU's photos
    // and writes copy about it. That is exactly how a Campus Crest T-Shirt ad
    // shipped the headline "Strength, in pink." over "Training Straight Leg
    // Leggings": the artifact was correctly the tee's, its contents were not,
    // and no downstream FK check can catch that because nothing is
    // mismatched — the Director was simply shown the wrong product.
    //
    // The tier-based path below has always scoped catalog media by
    // metadata.catalogProductId; this branch bypasses tier assembly and only
    // filtered by brandId ("never leak media from other brands"), which is the
    // same guarantee one level too coarse.
    //
    // Same standard as the deterministic-video seed path: a direct
    // catalogProductId, or an explicit outcome:'product_match'. A
    // 'product_category' match means detect placed the media in the same
    // CATEGORY as the SKU, which is not evidence it depicts THIS product.
    // Brand-only runs (productId null) keep every pick — no SKU to scope to.
    const associatesWithProduct = (m) => {
      if (isBrandOnly) return true;
      const pid = String(productId);
      if (m?.metadata?.catalogProductId != null && String(m.metadata.catalogProductId) === pid) return true;
      return (Array.isArray(m?.matchedProducts) ? m.matchedProducts : []).some(
        (x) => x?.catalogProductId != null && String(x.catalogProductId) === pid && x.outcome === 'product_match'
      );
    };
    const scopedMedias = pickedMedias.filter(associatesWithProduct);
    if (scopedMedias.length !== pickedMedias.length) {
      console.log(
        `🔒 seeded universe — ${pickedMedias.length - scopedMedias.length}/${pickedMedias.length} operator-picked media dropped for ` +
        `product ${productId}: they depict a different SKU`
      );
    }

    const pool = scopedMedias.map(m => {
      const isCatalog = m.source === 'catalog-product';
      const role = isCatalog ? 'catalog' : 'ugc_brand_match';
      if (isCatalog) counts.catalog++;
      else           counts.ugc_brand_match++;
      return { media: m, role };
    });

    const ranked = rankMergedPool(pool, { wantsVideo });
    const universe = ranked.map(x => projectEntry(x.media, x.role));
    const trimmed = universe.slice(0, topN);
    const seedUniverseHash = computeSeedUniverseHash(trimmed, 5);

    return { universe: trimmed, seedUniverseHash, counts };
  }

  // ── Catalog media ──────────────────────────────────────────────
  // Product mode: scope to the specific SKU via catalogProductId.
  // Brand mode: pull all catalog media for the brand, capped to a
  // reasonable pool size (shotType ranking sorts the winners).
  const BRAND_CATALOG_LIMIT = 50;
  const productOid = toObjectId(productId);
  const catalogQuery = isBrandOnly
    ? { source: 'catalog-product', brandId }
    : { source: 'catalog-product', 'metadata.catalogProductId': productOid };
  const catalogCursor = Media.find(catalogQuery)
    .select('_id fileType fileUrl createdAt classification metadata text');
  const catalogMedias = isBrandOnly
    ? await catalogCursor.limit(BRAND_CATALOG_LIMIT).lean()
    : await catalogCursor.lean();

  // ── UGC candidate IDs by tier ──────────────────────────────────
  // Product mode: tiers 1/2 come from the CatalogProduct.matchedMedia
  // mirror; tier 3 is opt-in via includeBrandMatched.
  // Brand mode: tiers 1/2 are product-specific and skipped; tier 3
  // always fires (brand-scoped UGC is the primary UGC source).
  let tier1Ids = [];
  let tier2Ids = [];
  if (!isBrandOnly) {
    const product = await CatalogProduct.findById(productId).select('matchedMedia').lean();
    const mmEntries = Array.isArray(product?.matchedMedia) ? product.matchedMedia : [];
    tier1Ids = mmEntries
      .filter(mm => mm.matchTier === 'product_match')
      .map(mm => String(mm.mediaId));
    tier2Ids = includeCategoryMatched
      ? mmEntries.filter(mm => mm.matchTier === 'product_category').map(mm => String(mm.mediaId))
      : [];
  }
  let tier3Ids = [];
  if (isBrandOnly || includeBrandMatched) {
    const brandMatches = await ProductMatchArtifact.find({
      brandId, outcome: 'brand_match'
    }).select('mediaId').lean();
    tier3Ids = brandMatches.map(m => String(m.mediaId));
  }

  // Bulk-load all UGC candidates once.
  const allUgcIds = Array.from(new Set([...tier1Ids, ...tier2Ids, ...tier3Ids]));
  const ugcMedias = allUgcIds.length ? await Media.find({
    _id: { $in: allUgcIds }
  }).select('_id fileType fileUrl source createdAt classification metadata platformStats matchedProducts refinedProducts text').lean() : [];
  const ugcById = new Map(ugcMedias.map(m => [String(m._id), m]));

  // ── Assemble the merged pool with role tags ────────────────────
  const pool = [];

  catalogMedias.forEach(m => { pool.push({ media: m, role: 'catalog' }); counts.catalog++; });

  // Tier 1 — apply content-nature gate; no cross-product guard.
  tier1Ids.forEach(id => {
    const m = ugcById.get(id);
    if (!m || !isContentNatureEligible(m)) return;
    pool.push({ media: m, role: 'ugc_product_match' });
    counts.ugc_product_match++;
  });

  // Tier 2 — cross-product guard: drop posts showing another identified SKU.
  tier2Ids.forEach(id => {
    const m = ugcById.get(id);
    if (!m || !isContentNatureEligible(m) || hasIdentifiedSpecificProduct(m)) return;
    pool.push({ media: m, role: 'ugc_product_category' });
    counts.ugc_product_category++;
  });

  // Tier 3 — stricter guard: drop posts with any product visibility.
  tier3Ids.forEach(id => {
    const m = ugcById.get(id);
    if (!m
        || !isContentNatureEligible(m)
        || hasIdentifiedSpecificProduct(m)
        || hasVisibleUnmatchedProduct(m)) return;
    pool.push({ media: m, role: 'ugc_brand_match' });
    counts.ugc_brand_match++;
  });

  // ── Rank the merged pool by shotType, then project ─────────────
  let ranked = rankMergedPool(pool, { wantsVideo });

  // Default image seed = the first image that came from the catalog (owner
  // rule — see the file header and promoteFirstCatalogImage's cascade).
  // Applied HERE, on the ranked wrappers, because:
  //   • it must land before projectEntry() — the cascade tests entry.role,
  //     media.metadata.imageRole and media.createdAt, and projectEntry
  //     flattens the first two into a Director-facing shape and drops the
  //     third entirely;
  //   • it must land before `.slice(0, topN)` below — with topN=1 the slice
  //     IS the whole decision, so a promotion after it does nothing;
  //   • it must NOT live inside rankMergedPool, which is also called by the
  //     operator-picked branch above (that branch is the override and
  //     returns before reaching this line);
  //   • !isBrandOnly is a required gate, not a nicety: brand mode pools the
  //     catalog media of EVERY product for the brand, so many docs are some
  //     SKU's first catalog image and "the catalog's first image" has no
  //     meaning — promoting whichever came back first would silently pick a
  //     SKU.
  //
  // A catalog image with burned-in text is still promoted, including on
  // wantsVideo runs where rankMergedPool penalizes burned text: the owner
  // rule outranks that tiebreak. Trade-off is deliberate and pinned by
  // scripts/verifySeededUniverseHeroDefault.js.
  if (preferFirstCatalogImage && !isBrandOnly) {
    const promoted = promoteFirstCatalogImage(ranked);
    const head = promoted[0] || null;
    // Post-cascade, head is role==='catalog' whenever the pool held ANY
    // catalog entry (tier 2 is exhaustive over them), so this doubles as the
    // tier-3 detector.
    const headIsCatalog = !!head && head.role === 'catalog';
    if (headIsCatalog && head !== ranked[0]) {
      const tier = head.media?.metadata?.imageRole === 'hero'
        ? "tier 1 (imageRole='hero')"
        : 'tier 2 (best-ranked catalog image)';
      console.log(
        `🎯 seeded universe — first catalog image ${String(head.media._id)} promoted to index 0 ` +
        `from rank ${ranked.indexOf(head)} of ${ranked.length} via ${tier} ` +
        `(product ${productId}, topN=${topN}): shotType ranking had it below another candidate`
      );
    } else if (!headIsCatalog && ranked.length) {
      console.log(
        `🎯 seeded universe — preferFirstCatalogImage requested but no catalog entry in the pool ` +
        `for product ${productId} (pool=${ranked.length}) — keeping shotType rank`
      );
    }
    ranked = promoted;
  }

  const universe = ranked.map(x => projectEntry(x.media, x.role));

  const trimmed = universe.slice(0, topN);
  const seedUniverseHash = computeSeedUniverseHash(trimmed, 5);

  return { universe: trimmed, seedUniverseHash, counts };
}

module.exports = {
  buildSeededUniverse,
  computeSeedUniverseHash,
  // Exposed for testing / reuse by adjacent services.
  rankMergedPool,
  promoteFirstCatalogImage,
  isContentNatureEligible
};
