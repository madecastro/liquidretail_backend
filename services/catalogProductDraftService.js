// Upload-4: auto-create draft CatalogProduct rows from confident
// detect outcomes. Closes the loop where a brand's media surfaces
// products that aren't yet in their catalog — instead of forcing the
// user to manually catalog every match-worthy SKU, we write a draft
// row with everything detect can derive (title, description, category,
// imageUrl) and surface it in the catalog browser's drafts queue for
// the user to complete (price + productUrl).
//
// Fire-and-forget from detect.js — never throws to the pipeline. Skips
// silently when the brand hasn't opted in.
//
// Idempotent: externalId is stable on (mediaId, title-slug) so re-runs
// of the same Media upsert the same draft, and same product detected
// on different Media yields one draft per Media (cleanup is the user's
// job in the drafts UI — better than over-engineering matching here).

const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const { normalizeTitle, tokens } = require('../utils/titleNormalize');
const {
  UNIVERSAL_STOP_TOKENS,
  brandStopTokens
} = require('./catalogRetroLinkService');

// Match the productMatchService HIGH_CONFIDENCE constant — same
// threshold that makes a match "confident enough" for ad creative is
// the same threshold that makes it "confident enough" to draft.
const HIGH_CONFIDENCE = 0.80;

// Kill switch for the pre-mint catalog-subset collapse. Default on.
// Any other value ('false', '0', 'off') disables — restoring the
// pre-2026-09-01 behaviour where every high-confidence non-catalog
// winner minted a draft, even when the identified productName was a
// full merchant description that wraps an existing catalog family
// name. Written verbosely (not `!== 'false'`) so future callers who
// pass '0' or 'off' don't silently opt in.
function isCollapseToCatalogEnabled() {
  const raw = String(process.env.DRAFT_COLLAPSE_TO_CATALOG || 'true')
    .toLowerCase().trim();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

// Fit-modifier tokens that must NOT be stripped when computing the
// draft-collapse subset — they distinguish independent SKU families
// (mens vs womens, adult vs youth) and stripping them merges every
// "Aquatek Deluxe" (mens) into "Ws Aquatek" (womens), and every
// "Strike" (adult) into "Youth Strike" (kids).
//
// UNIVERSAL_STOP_TOKENS (from catalogRetroLinkService) legitimately
// includes these because the retro-link scoring path compares against
// UGC captions where fit is not called out — a UGC post reading
// "PELAGIC Aquatek gets me through summer" should still link a
// women's Aquatek catalog row for a women's brand. That call is
// correct there. Here the input is Gemini's identified productName
// for a SPECIFIC SKU photograph, so fit modifiers are ground truth.
const FIT_MODIFIER_TOKENS = new Set(['ws', 'mens', 'womens', 'youth', 'kids']);

function draftCollapseStopwords(brandName) {
  const stops = new Set([
    ...UNIVERSAL_STOP_TOKENS,
    ...brandStopTokens(brandName || '')
  ]);
  for (const t of FIT_MODIFIER_TOKENS) stops.delete(t);
  return stops;
}

// Find a non-draft catalog row whose normalized-title tokens are all
// present in `productName`'s tokens (subset match, catalog ⊆ draft).
//
// The Pelagic pattern: catalog rows are terse product-family names
// ("Freespool", "Vaportek", "Mako", "Icon", "Knockdown"), while
// Gemini's identified productName is a full merchant description
// ("PELAGIC Hooded Performance Shirt - Freespool"). After stripping
// brand + apparel stopwords, the catalog reduces to [freespool] and
// the draft reduces to [freespool] — same shared token, but the
// productMatchService catalog-first check misses this because it
// scores against the DINO refined label ("hooded fishing shirt"),
// not the Gemini-identified productName which arrives later.
//
// Rejects the ambiguous / adjacent-SKU cases the raw score would
// otherwise collapse:
//   - "Flybridge Deluxe" ⊄ "PELAGIC T-Shirt - Deluxe"       (missing flybridge)
//   - "Youth Strike"     ⊄ "PELAGIC Boardshorts - Strike"   (missing youth  → adult/kid SKU split)
//   - "Ws Aquatek"       ⊄ "Aquatek Deluxe"                 (missing ws     → mens/womens split)
// A 0-token candidate (all stopwords) never matches — a subset check
// against the empty set is vacuously true, and that would collapse
// every draft into the first stopword-only catalog row.
//
// When multiple candidates satisfy subset, picks the most SPECIFIC
// (highest shared token count) — a "Aquatek Deluxe" draft prefers a
// "Aquatek Deluxe" catalog match over a bare "Aquatek" if both exist.
function findCatalogSubsetMatch(productName, catalogRows, extraStop) {
  const draftTokens = new Set(tokens(normalizeTitle(productName), extraStop));
  if (!draftTokens.size) return null;

  let best = null;
  for (const row of catalogRows) {
    const rowTokens = new Set(tokens(normalizeTitle(row.title || ''), extraStop));
    if (!rowTokens.size) continue;   // stopword-only candidate — reject
    let isSubset = true;
    for (const t of rowTokens) {
      if (!draftTokens.has(t)) { isSubset = false; break; }
    }
    if (!isSubset) continue;
    const shared = rowTokens.size;
    if (!best || shared > best.shared) {
      best = { row, shared };
    }
  }
  return best;
}

// `force: true` bypasses the certainty threshold + brand opt-in
// soft guards. Used by the Upload-7 manual "Save as draft product"
// CTA — when a user explicitly clicks save, they're vouching for the
// match even at lower confidence and even if the brand hasn't opted
// into bulk auto-create.
async function maybeCreateDraftFromMatch({ media, productMatch, sceneImageUrl, yoloProducts, force = false }) {
  try {
    return await tryCreate({ media, productMatch, sceneImageUrl, yoloProducts, force });
  } catch (err) {
    console.warn(`   ⚠️  draft auto-create unexpected error: ${err.message}`);
    return { created: false, reason: `unexpected: ${err.message}` };
  }
}

async function tryCreate({ media, productMatch, sceneImageUrl, yoloProducts, force }) {
  // ── Hard guards (always enforced) ────────────────────────────────
  if (!media || !productMatch) return { created: false, reason: 'missing inputs' };
  if (!media.brandId || !media.advertiserId) return { created: false, reason: 'media has no brand/advertiser' };
  if (productMatch.outcome !== 'product_match') return { created: false, reason: `outcome=${productMatch.outcome}` };
  // Catalog already won → that row IS the product. Skip.
  if (productMatch.winner === 'catalog') return { created: false, reason: 'catalog match already exists' };

  // ── Soft guards (skipped on force=true) ──────────────────────────
  if (!force) {
    const certainty = productMatch.identification?.certainty || 0;
    if (certainty < HIGH_CONFIDENCE) {
      return { created: false, reason: `certainty ${certainty.toFixed(2)} < ${HIGH_CONFIDENCE}` };
    }
  }

  // Brand fetch is needed regardless (we populate row.brand from it).
  const brand = await Brand.findById(media.brandId).select('name uploadSettings').lean();
  if (!brand) return { created: false, reason: 'brand not found' };
  if (!force && !brand.uploadSettings?.autoCreateFromDetect) {
    return { created: false, reason: 'autoCreateFromDetect disabled for brand' };
  }

  // ── Title / slug / externalId ────────────────────────────────────
  const productName = (productMatch.identification?.productName || '').trim();
  if (!productName) return { created: false, reason: 'no productName' };

  const slug = slugify(productName);
  if (!slug) return { created: false, reason: 'productName produces empty slug' };
  const externalId = `detect:${media._id}:${slug}`;

  // ── Pre-mint catalog-subset collapse ─────────────────────────────
  // Gate 1 (productMatchService.catalogFirstMatchOneRefined) runs
  // against the DINO refined label ("hooded fishing shirt") and can't
  // see Gemini's identified productName ("PELAGIC ... - Freespool").
  // On a Pelagic-style catalog where synced titles are terse
  // product-family names, that gate scores near-zero against every
  // catalog row and Gemini wins by default — even when the family
  // name IS in the productName that we're about to mint a draft for.
  // Measured 2026-09-01: 30 of 49 (61%) Pelagic drafts had a synced
  // sibling whose title is a token-subset of the draft title but
  // scored below the primary catalog-first gate.
  //
  // Kill switch: DRAFT_COLLAPSE_TO_CATALOG=false reverts.
  // NEVER runs under force: manual "Save as draft product" is an
  // explicit operator vouch that this IS a new SKU distinct from any
  // catalog family it superficially matches.
  if (!force && isCollapseToCatalogEnabled()) {
    try {
      const extraStop = draftCollapseStopwords(brand.name);
      const catalogRows = await CatalogProduct
        .find({ brandId: media.brandId, draft: { $ne: true }, deletedAt: null })
        .select('_id title').lean();
      const subsetMatch = findCatalogSubsetMatch(productName, catalogRows, extraStop);
      if (subsetMatch) {
        console.log(
          `   ↔️  draft collapse: "${productName}" is a superset of existing catalog ` +
          `"${subsetMatch.row.title}" (${subsetMatch.row._id}) — skipping draft`
        );
        return {
          created: false,
          reason: `catalog-subset match on "${subsetMatch.row.title}"`,
          matchedCatalogId: subsetMatch.row._id
        };
      }
    } catch (err) {
      // Never let the collapse check block a draft that would otherwise
      // land — a broken query here is a soft signal loss, not a mint bug.
      console.warn(`   ⚠️  draft catalog-subset check threw: ${err.message} — proceeding with mint`);
    }
  }

  // ── Image cascade ────────────────────────────────────────────────
  // Best: Gemini surfaced a clean product page image.
  // OK: caller passed the scene image (heroImageUrl for video,
  //     fileUrl for image media).
  // Last resort: media.fileUrl directly.
  const imageUrl = productMatch.identification?.details?.imageUrl
                || sceneImageUrl
                || media.fileUrl
                || null;

  // ── Category + description from the YOLO winner (if available) ──
  // YOLO carries a category enum we can populate; Gemini doesn't.
  // primarySubjectDesc on the query is the GPT-4.1 scene description —
  // useful as a description starter even when YOLO didn't fire.
  const yoloTop = (yoloProducts || [])
    .map(p => p?.identification)
    .filter(id => id && id.label && id.label !== 'non-product' && (id.confidence || 0) >= 0.7)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
  const category = yoloTop?.category || null;
  const description = productMatch.identification?.details?.description
                   || productMatch.query?.primarySubject
                   || yoloTop?.description
                   || null;

  // ── Upsert ───────────────────────────────────────────────────────
  // Re-runs on the same Media land on the same externalId so they
  // refresh fields without creating duplicates. The (brandId,
  // externalId) unique index guarantees one row per natural key.
  const benefits = require('./productBenefitsService');
  const prevDoc = await benefits.loadPrevForBenefits(media.brandId, externalId);
  const { changed: benefitsStale } = benefits.markBenefitsStaleIfTextChanged(
    prevDoc,
    { title: productName, description }
  );

  let result;
  try {
    const upsertUpdate = {
      $set: {
        title:        productName,
        description,
        category,
        brand:        brand.name || null,
        lastSyncedAt: new Date()
      },
      $setOnInsert: {
        advertiserId:        media.advertiserId,
        brandId:             media.brandId,
        source:              'detect-identified',
        externalId,
        draft:               true,
        // Detect-identified drafts are by definition single SKUs, not
        // variant siblings of an item-group. Without this, the schema
        // default (false) makes them invisible to the catalog list's
        // primary-variants-only filter — which the detect review page
        // hits to surface the queue.
        isPrimaryVariant:    true,
        detectedFromMediaId: media._id,
        firstSeenAt:         new Date()
      }
    };
    // null → url heals; a missing detect image must not clobber a good URL.
    require('./catalogImageUrlGuard').assignImageUrl(upsertUpdate.$set, imageUrl);
    benefits.applyBenefitsStaleToUpdate(upsertUpdate, benefitsStale);
    result = await CatalogProduct.findOneAndUpdate(
      { brandId: media.brandId, externalId },
      upsertUpdate,
      { upsert: true, new: true, rawResult: true }
    );
  } catch (err) {
    return { created: false, reason: `upsert failed: ${err.message}` };
  }

  const isNew = !result?.lastErrorObject?.updatedExisting;
  const draftId = result?.value?._id;
  if (isNew) {
    if (result?.value) {
      benefits.scheduleForProduct({ product: result.value, brand });
    }
    console.log(`📝 draft product auto-created: "${productName}" brand=${brand.name} cred=${draftId}`);
    return { created: true, draftId, productName, externalId };
  }
  if (benefitsStale && result?.value) {
    benefits.scheduleForProduct({ product: benefits.redriveView(result.value), brand });
  }
  return { created: false, reason: 'already exists (refreshed)', draftId, externalId };
}

// Lowercase, dashes between alphanumeric runs, no leading/trailing
// dashes, capped at 80 chars to keep externalIds readable in logs.
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

module.exports = {
  maybeCreateDraftFromMatch,
  // Exported for scripts/verifyDraftCatalogCollapse.js — pure helpers
  // so the harness can drive the subset math with fixtures rather than
  // spin up Mongoose.
  __test: {
    findCatalogSubsetMatch,
    isCollapseToCatalogEnabled,
    draftCollapseStopwords,
    FIT_MODIFIER_TOKENS
  }
};
