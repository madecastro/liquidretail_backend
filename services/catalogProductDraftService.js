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

// Match the productMatchService HIGH_CONFIDENCE constant — same
// threshold that makes a match "confident enough" for ad creative is
// the same threshold that makes it "confident enough" to draft.
const HIGH_CONFIDENCE = 0.85;

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
    .filter(id => id && id.label && (id.confidence || 0) >= 0.7)
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
  let result;
  try {
    result = await CatalogProduct.findOneAndUpdate(
      { brandId: media.brandId, externalId },
      {
        $set: {
          title:        productName,
          description,
          category,
          brand:        brand.name || null,
          imageUrl,
          lastSyncedAt: new Date()
        },
        $setOnInsert: {
          advertiserId:        media.advertiserId,
          brandId:             media.brandId,
          source:              'detect-identified',
          externalId,
          draft:               true,
          detectedFromMediaId: media._id,
          firstSeenAt:         new Date()
        }
      },
      { upsert: true, new: true, rawResult: true }
    );
  } catch (err) {
    return { created: false, reason: `upsert failed: ${err.message}` };
  }

  const isNew = !result?.lastErrorObject?.updatedExisting;
  const draftId = result?.value?._id;
  if (isNew) {
    console.log(`📝 draft product auto-created: "${productName}" brand=${brand.name} cred=${draftId}`);
    return { created: true, draftId, productName, externalId };
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

module.exports = { maybeCreateDraftFromMatch };
