// Catalog-product → DetectRun trigger.
//
// Per the product-path design (Option C): hero gets the full
// trimmed pipeline (subjects+text → crops → judge → palette);
// alts get a stripped pass (crops + palette only). One wrapper
// Media doc per image so existing artifact collections (keyed by
// mediaId) fan out cleanly.
//
// Idempotency: if CatalogProduct.imageMediaId already exists and
// the wrapper Media's fileUrl matches the current hero, the trigger
// no-ops. To force a re-detect (e.g. brand re-uploaded the image at
// the same URL), an operator clears imageMediaId on the doc.
//
// Cost gate: alts are capped at MAX_ALT_IMAGES so a chatty catalog
// (e.g. Shopify's 10+ angle shots per SKU) doesn't blow up the bill.

const mongoose = require('mongoose');
const Media = require('../models/Media');
const DetectRun = require('../models/DetectRun');
const CatalogProduct = require('../models/CatalogProduct');
const { uploadUrlToCloudinary } = require('./cloudinaryService');
const { normalizeBrandName } = require('../models/Brand');
const progressService = require('./progressService');
const {
  storedStyleForUrl,
  technicalInsightsFromStored,
  shouldApplyStoredShot
} = require('./ingestShotClassifyService');

// MATERIALISATION cost gate — how many alts get mirrored to Cloudinary +
// a Media row. SEPARATE knob from CATALOG_MAX_ADDITIONAL_IMAGES (storage,
// free strings); the two must stay independently tunable so raising one
// never silently moves the other.
//
// Raised 12 → 20 on 2026-08-10 by owner directive: "I don't mind spending
// the money to mirror images in order to ensure there is stability."
// Mirroring is what makes a catalog image durable — an un-mirrored
// merchant URL breaks when the store rotates its CDN or unpublishes the
// asset. The marginal cost here is Cloudinary storage/bandwidth, NOT AI
// spend: detect itself is still deferred (CATALOG_DETECT_PRECOMPUTE=false),
// so extra alts do not each trigger a paid detect run.
//
// Invariant: never mirror more than we store — see verifyCatalogImageCap G.
const MAX_ALT_IMAGES = Math.max(
  0,
  parseInt(process.env.CATALOG_MAX_ALT_IMAGES, 10) || 20
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
function toOid(id) {
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
}

// ── Public API ───────────────────────────────────────────────────────

// Enqueue the product-path detect pipeline for one CatalogProduct.
// Returns { enqueued: { hero, alts }, skipped: bool, reason? }.
async function enqueueProductDetect(product) {
  if (!product.imageUrl) {
    console.log(`   · catalog-product detect skip[${product._id}]: no hero imageUrl`);
    return { skipped: true, reason: 'product has no hero imageUrl' };
  }

  // Skip-if-already-attached. Re-runs are an explicit operator
  // action (clear imageMediaId on the CatalogProduct doc).
  //
  // This function OWNS pointer derivation, so it must not be reused to "just
  // add the missing detect run" for a product that already has pointers: its
  // alt array is built compact (filter + push) while materializeMissingAlts
  // maintains an INDEX-ALIGNED one, and rewriting would mis-pair alt URLs with
  // alt media ids. ensureDetectRunsForExistingMedia is that path instead.
  if (product.imageMediaId) {
    // Report the pointer so callers asking "is there a usable hero Media"
    // get an answer on the skip path too, instead of reading undefined and
    // concluding NO_HERO_MEDIA.
    return {
      skipped: true,
      reason: 'already detected (imageMediaId set)',
      heroMediaId: String(product.imageMediaId)
    };
  }

  console.log(
    `   · catalog-product detect enqueue[${product._id}]: ` +
    `"${(product.title || '').slice(0, 40)}" hero=1 alts=${(product.additionalImages || []).length}`
  );

  const enqueued = { hero: null, alts: [] };

  // Media EXISTENCE, tracked separately from detect-run creation.
  //
  // These two are unrelated concerns and conflating them is what greyed the
  // "PRIMARY" tile in the Step 2 picker. `enqueued.hero` is only set when a
  // DetectRun was also created; a Media doc whose run creation returned null
  // (createDetectRunIfAbsent's E11000-but-no-in-flight-run branch) is still a
  // perfectly usable picker tile and video reference. Persisting the pointer
  // from the run instead of from the Media threw that away, and — because the
  // skip gate above only re-enters when imageMediaId is null — the product
  // then stayed null on every later pass.
  let heroMediaId = null;
  const altMediaIds = [];

  // Hero — full path.
  try {
    const heroMedia = await materializeImage({
      sourceUrl:    product.imageUrl,
      product,
      imageRole:    'hero',
      feedIndex:    0
    });
    if (heroMedia) {
      heroMediaId = String(heroMedia._id);
      const run = await createDetectRunIfAbsent(heroMedia, product);
      if (run) enqueued.hero = { mediaId: heroMediaId, runId: String(run._id) };
    }
  } catch (err) {
    console.warn(`⚠️  catalog-product[${product._id}] hero detect enqueue failed: ${err.message}`);
  }

  // Alts — stripped path. Capped + de-duped against hero URL.
  const altUrls = (product.additionalImages || [])
    .filter(u => u && u !== product.imageUrl)
    .slice(0, MAX_ALT_IMAGES);

  for (let altPos = 0; altPos < altUrls.length; altPos++) {
    const altUrl = altUrls[altPos];
    try {
      const altMedia = await materializeImage({
        sourceUrl:    altUrl,
        product,
        imageRole:    'alt',
        feedIndex:    altPos + 1
      });
      if (altMedia) {
        const altMediaId = String(altMedia._id);
        altMediaIds.push(altMediaId);
        const run = await createDetectRunIfAbsent(altMedia, product);
        if (run) enqueued.alts.push({ mediaId: altMediaId, runId: String(run._id) });
      }
    } catch (err) {
      console.warn(`⚠️  catalog-product[${product._id}] alt detect enqueue failed: ${err.message}`);
    }
  }

  // Stamp the wrapper ids onto the CatalogProduct so future re-syncs
  // skip and so visualCatalogMatchService can fan out across all
  // image variants when matching UGC against this product.
  //
  // Written from the materialize results, NOT from `enqueued` — see the
  // heroMediaId comment above.
  //
  // Persist ONLY what we actually resolved. The old unconditional write set
  // `imageMediaId: null` / `additionalImageMediaIds: []` whenever materialize
  // failed, which was survivable while this function was the single writer and
  // only ran with a null pointer. It no longer is: materializeMissingHero (the
  // catalog detail endpoint) is a second writer, and `product` here is a
  // snapshot that can predate it. Writing our failure over its success would
  // re-grey a tile that had just been fixed, and would wipe the index-aligned
  // additionalImageMediaIds that materializeMissingAlts maintains.
  const update = {};
  if (heroMediaId) update.imageMediaId = heroMediaId;
  if (altMediaIds.length) update.additionalImageMediaIds = altMediaIds;
  if (Object.keys(update).length) {
    await CatalogProduct.updateOne({ _id: product._id }, { $set: update });
  }

  // heroMediaId / altMediaIds are the media-existence view; callers that need
  // "is there a usable hero Media" must read these rather than
  // `enqueued.hero` (which answers the different question "did we also queue
  // a detect run"). expandDeterministicVideo's lazy materialize depends on
  // this distinction — reading enqueued.hero there dropped whole video ads
  // as NO_HERO_MEDIA.
  return { enqueued, heroMediaId, altMediaIds };
}

// Queue detect runs for Media a product ALREADY points at, deriving nothing
// and persisting nothing.
//
// This is the re-entry path for a product whose hero Media exists but was never
// detected — the state the catalog detail endpoint's lazy hero backfill creates
// on purpose (it stamps imageMediaId and deliberately queues no run, so merely
// viewing a product costs no Gemini vision). ensureDetectForProducts needs the
// run at ad time; it must NOT reuse enqueueProductDetect to get it, because
// that function re-derives pointers and writes additionalImageMediaIds as a
// COMPACT array, whereas materializeMissingAlts maintains an INDEX-ALIGNED one
// (holes where an alt URL duplicates the hero or its mirror failed). Rewriting
// compacts it and silently mis-pairs every alt URL with the wrong media id —
// which the detail response, the alt crop galleries and operator exclusion
// pairings all zip by index.
//
// Idempotent: media that already have a DetectRun in ANY status are skipped, so
// repeat calls create nothing. No materialize, so no Cloudinary traffic and no
// dependence on the hero URL still resolving.
async function ensureDetectRunsForExistingMedia(product) {
  const mediaIds = [
    product.imageMediaId,
    ...(Array.isArray(product.additionalImageMediaIds) ? product.additionalImageMediaIds : [])
  ].filter(Boolean).map(String);
  if (!mediaIds.length) return { runsCreated: 0, considered: 0 };

  // Scope to this brand's catalog-product media — the ids come off the product
  // doc, but a stale pointer to another brand's Media must not be detected here.
  const docs = await Media.find({
    _id:     { $in: mediaIds },
    brandId: product.brandId,
    source:  'catalog-product'
  }).select('_id').lean();
  if (!docs.length) return { runsCreated: 0, considered: 0 };

  // One batched query. createDetectRunIfAbsent only de-dupes against IN-FLIGHT
  // runs (that is all its partial unique index covers), so without this a
  // completed run would be re-created on every ad generation — an unbounded
  // detect-run factory on a path that runs per generate.
  const existing = await DetectRun.find({ mediaId: { $in: docs.map(d => d._id) } })
    .select('mediaId').lean();
  const alreadyRun = new Set(existing.map(r => String(r.mediaId)));
  const needed = docs.filter(d => !alreadyRun.has(String(d._id)));
  if (!needed.length) return { runsCreated: 0, considered: docs.length };

  let runsCreated = 0;
  for (const media of needed) {
    try {
      const run = await createDetectRunIfAbsent(media, product);
      if (run) runsCreated++;
    } catch (err) {
      console.warn(
        `⚠️  catalog-product[${product._id}] detect run for existing media ${media._id} failed: ${err.message}`
      );
    }
  }
  console.log(
    `   · catalog-product detect runs[${product._id}]: ${runsCreated} created for ` +
    `${needed.length} undetected media (of ${docs.length} existing)`
  );
  return { runsCreated, considered: docs.length };
}

// Bulk wrapper — fire enqueueProductDetect for the primary variant of
// each product group. Used by catalogSyncService at the end of a sync
// pass.
//
// Variant collapse: Shopify-via-Meta returns each size/color variant
// as a distinct catalog row (e.g. 8 sizes of "HCO Original" = 8 rows
// sharing the same hero image). Without dedup we'd pay for detect on
// every variant. We group by itemGroupId when Meta provides it, and
// fall back to nameNormalized when it doesn't. Within each group we
// pick a primary (most images, tiebreak lowest externalId) and only
// the primary runs detect. The rest get isPrimaryVariant=false and
// stay query-visible for commerce; downstream matchers should filter
// to primaries to avoid scoring the same image across variants.
async function enqueueBrandProductDetects(brandId) {
  const products = await CatalogProduct.find({
    brandId,
    imageUrl: { $ne: null }
  }).lean();

  // Group → primary selection. We also track which primary each non-
  // primary belongs to so we can stamp primaryProductId atomically
  // (needed for matchedMedia inheritance + catalog browser matchCount
  // $lookup on non-primary cards).
  const groups = groupProductsForDetect(products);
  const primaries        = [];
  const nonPrimaries     = [];          // collected for logging / return; mirrors variantsByPrimary's flat set
  const variantsByPrimary = new Map();   // primary._id (string) → [variant._id, ...]
  for (const group of groups.values()) {
    const primary = pickPrimary(group);
    primaries.push(primary);
    const variantIds = [];
    for (const p of group) {
      if (String(p._id) !== String(primary._id)) {
        variantIds.push(p._id);
        nonPrimaries.push(p);
      }
    }
    if (variantIds.length) variantsByPrimary.set(String(primary._id), variantIds);
  }

  // Stamp the variant role so the match service + UI can join on it.
  // Done before enqueue so a partial-failure run still leaves the flag
  // set consistently. Primaries also get primaryProductId cleared (in
  // case a row previously belonged to a different family — e.g. after
  // a title rename).
  if (primaries.length) {
    await CatalogProduct.updateMany(
      { _id: { $in: primaries.map(p => p._id) } },
      { $set: { isPrimaryVariant: true, primaryProductId: null } }
    );
  }
  // Per-family bulkWrite so each non-primary points at the right primary.
  if (variantsByPrimary.size) {
    const bulkOps = [];
    for (const [primaryId, variantIds] of variantsByPrimary.entries()) {
      bulkOps.push({
        updateMany: {
          filter: { _id: { $in: variantIds } },
          update: { $set: { isPrimaryVariant: false, primaryProductId: primaryId } }
        }
      });
    }
    await CatalogProduct.bulkWrite(bulkOps, { ordered: false });
  }

  // DETECT DEFERRAL (default): per-product detect — smart crops, overlay
  // safe-zones, ad-readiness scoring — is the biggest cost in the pipeline
  // and most catalog products never become ads. It now runs ON-DEMAND at
  // ad-generation time (ensureDetectForProducts), not eagerly for the whole
  // catalog at sync time. The variant-role stamping ABOVE still runs on
  // every sync (matching + catalog UI depend on isPrimaryVariant /
  // primaryProductId — cost-free DB writes); only the expensive image
  // enqueue below is gated. Flip CATALOG_DETECT_PRECOMPUTE=true to restore
  // eager whole-catalog precompute.
  const precompute = String(process.env.CATALOG_DETECT_PRECOMPUTE || '').toLowerCase() === 'true';
  if (!precompute) {
    console.log(
      `📦 catalog-product detect — brand=${brandId} DEFERRED to ad-time ` +
      `(CATALOG_DETECT_PRECOMPUTE≠true) — variant roles stamped, no eager detect. ` +
      `groups=${groups.size} primaries=${primaries.length} variants=${nonPrimaries.length} (rows ${products.length})`
    );
    return {
      deferred: true, heroEnqueued: 0, altEnqueued: 0, skipped: primaries.length,
      groups: groups.size, primaries: primaries.length,
      variants: nonPrimaries.length, total: products.length
    };
  }

  // Only primaries that haven't been detected yet need an enqueue
  // call. Already-detected primaries no-op via the imageMediaId check
  // inside enqueueProductDetect.
  let heroEnqueued = 0;
  let altEnqueued  = 0;
  let skipped      = 0;
  for (const p of primaries) {
    if (p.imageMediaId) { skipped++; continue; }
    const r = await enqueueProductDetect(p);
    if (r.skipped) { skipped++; continue; }
    if (r.enqueued?.hero) heroEnqueued++;
    altEnqueued += r.enqueued?.alts?.length || 0;
  }

  console.log(
    `📦 catalog-product detect — brand=${brandId} ` +
    `groups=${groups.size} primaries=${primaries.length} variants=${nonPrimaries.length} ` +
    `heroes=${heroEnqueued} alts=${altEnqueued} skipped=${skipped} (rows ${products.length})`
  );
  return {
    heroEnqueued, altEnqueued, skipped,
    groups:    groups.size,
    primaries: primaries.length,
    variants:  nonPrimaries.length,
    total:     products.length
  };
}

// ── On-demand detect (ad-generation time) ────────────────────────────
//
// Detect is deferred at sync time (see enqueueBrandProductDetects); this
// is the pull side. Given the CatalogProduct ids a campaign will actually
// use, ensure each has its catalog-product Media (so product_image seeds
// emit) + overlay-zone artifacts (so placement / ad-readiness work).
// Materialize + enqueue is fast; the bounded wait blocks until zones land
// — they arrive via detect.js's lazy overlay chain AFTER the DetectRun's
// critical path, so we poll the Media doc, not DetectRun status. Surfaced
// as a cancellable 'detect' OperationRun so it appears in the activity
// dock. On timeout we return and the caller proceeds — the render path
// degrades gracefully without spatial analysis.
async function ensureDetectForProducts(catalogProductIds, {
  advertiserId = null,
  brandId      = null,
  wait         = true,
  timeoutMs    = 4 * 60 * 1000,
  run: passedRun = null
} = {}) {
  const oids = [...new Set((catalogProductIds || []).map(String))].map(toOid).filter(Boolean);
  if (!oids.length) return { ensured: 0, ready: 0, timedOut: 0, total: 0 };

  // Collapse variants to their primary (matching + seeds already operate on
  // primaries via isPrimaryVariant; without this a campaign using several
  // SKUs of one product would re-materialize + re-detect the same hero N
  // times). Map each requested id → primaryProductId || itself, dedupe.
  const requested = await CatalogProduct.find({ _id: { $in: oids } })
    .select('_id primaryProductId').lean();
  if (!requested.length) return { ensured: 0, ready: 0, timedOut: 0, total: 0 };
  const primaryOids = [...new Set(requested.map(p => String(p.primaryProductId || p._id)))]
    .map(toOid).filter(Boolean);
  const products = await CatalogProduct.find({ _id: { $in: primaryOids }, imageUrl: { $ne: null } }).lean();
  if (!products.length) return { ensured: 0, ready: 0, timedOut: 0, total: 0 };

  // 1. Materialize + enqueue detect for products without a hero wrapper.
  //    (enqueueProductDetect is the per-product path — NOT gated by
  //    CATALOG_DETECT_PRECOMPUTE.)
  //
  //    GATED ON THE DETECT RUN, NOT ON THE POINTER. `imageMediaId` proves a
  //    hero Media EXISTS; it does not prove detect ever ran on it. The catalog
  //    detail endpoint's lazy hero backfill deliberately stamps the pointer
  //    with no DetectRun (that is its cost fence), so a pointer-only gate here
  //    would skip exactly those products — and this function is the sole
  //    guarantee that crops / overlay zones / ad-readiness exist by ad time.
  //    The result would be a paid ad rendered with no spatial analysis, and
  //    the "degrades gracefully" path swallowing it silently.
  //
  //    One batched query, not one per product. A run in ANY status counts:
  //    completed runs are what we want to skip, and a failed one matches the
  //    pre-existing behaviour of not retrying inside a single ad request (the
  //    wait loop below drops failed/absent rather than stalling on them).
  const pointerIds = products.map(p => p.imageMediaId).filter(Boolean);
  const detectedMediaIds = new Set();
  if (pointerIds.length) {
    const runs = await DetectRun.find({ mediaId: { $in: pointerIds } })
      .select('mediaId').lean();
    for (const r of runs) detectedMediaIds.add(String(r.mediaId));
  }

  let ensured = 0;
  for (const p of products) {
    if (p.imageMediaId && detectedMediaIds.has(String(p.imageMediaId))) continue;
    try {
      if (p.imageMediaId) {
        // Pointer already correct (lazy backfill) — ONLY the run is missing.
        // Runs-only on purpose: enqueueProductDetect would re-derive pointers
        // and compact the index-aligned additionalImageMediaIds.
        const r = await ensureDetectRunsForExistingMedia(p);
        if (r.runsCreated) ensured++;
      } else {
        const r = await enqueueProductDetect(p);
        if (!r.skipped) ensured++;
      }
    } catch (err) {
      console.warn(`   ⚠️  ensureDetectForProducts[${p._id}]: ${err.message}`);
    }
  }

  console.log(`🎯 ensureDetectForProducts: ${products.length} primary product(s), ${ensured} newly enqueued (wait=${wait})`);
  if (!wait) return { ensured, ready: 0, timedOut: products.length, total: products.length };

  // 2. Bounded wait for overlay zones to land on each product's hero.
  //    Zones land via detect.js's lazy overlay chain AFTER the DetectRun's
  //    critical path, so poll the Media doc. Only WAIT on products that (a)
  //    have a hero Media and (b) still have an in-flight DetectRun — so a
  //    failed materialize, or a product whose detect already died without
  //    landing zones, doesn't stall the whole batch for the full timeout.
  const run = passedRun || await progressService.startRun({
    kind:         'detect',
    advertiserId: advertiserId || products[0].advertiserId,
    brandId:      brandId || products[0].brandId,
    total:        products.length,
    cancellable:  true,
    label:        'Preparing product imagery'
  });

  const pending = new Set(products.map(p => String(p._id)));  // productId strings
  let ready = 0;
  let cancelled = false;
  let errored = false;
  const deadline = Date.now() + timeoutMs;

  try {
    while (pending.size && Date.now() < deadline) {
      const heros = await Media.find({
        source: 'catalog-product',
        'metadata.catalogProductId': { $in: [...pending].map(toOid) },
        'metadata.imageRole': 'hero'
      }).select('_id metadata.catalogProductId latestArtifacts.overlayZones').lean();

      const heroByProduct = new Map();
      for (const m of heros) heroByProduct.set(String(m.metadata?.catalogProductId), m);

      for (const pid of [...pending]) {
        const m = heroByProduct.get(pid);
        if (!m) { pending.delete(pid); continue; }          // no hero Media → can't wait (materialize failed)
        if (m.latestArtifacts?.overlayZones) {
          pending.delete(pid);
          ready++;
          run.tick(ready, products.length, `product imagery ${ready}/${products.length}`);
        }
      }
      if (!pending.size) break;

      // Per-product fast-fail: overlay zones land via detect.js's LAZY
      // chain AFTER the DetectRun flips to 'completed' (pipelines/detect.js
      // — run.status='completed' returns before the fire-and-forget overlay
      // chain finishes). So 'completed' is a normal wait state, NOT a stop
      // signal. Drop a product only when its latest hero DetectRun is
      // 'failed' or absent (nothing will ever produce zones) — keeping
      // queued/processing/completed waiting until zones land or timeout.
      const pendingHeroIds = [...pending].map(pid => heroByProduct.get(pid)?._id).filter(Boolean);
      if (pendingHeroIds.length) {
        const runRows = await DetectRun.find({ mediaId: { $in: pendingHeroIds } })
          .sort({ createdAt: -1 }).select('mediaId status').lean();
        const latestByMedia = new Map();
        for (const r of runRows) {
          const k = String(r.mediaId);
          if (!latestByMedia.has(k)) latestByMedia.set(k, r.status);   // first = newest (sorted desc)
        }
        for (const pid of [...pending]) {
          const hid = heroByProduct.get(pid)?._id;
          const st = hid ? latestByMedia.get(String(hid)) : null;
          if (st == null || st === 'failed') pending.delete(pid);      // dead / never-started → won't produce zones
        }
        if (!pending.size) break;
      }

      try { await run.checkpoint(); } catch { cancelled = true; break; }
      await sleep(3000);
    }
  } catch (err) {
    errored = true;
    console.warn(`   ⚠️  ensureDetectForProducts wait failed: ${err.message}`);
    if (!passedRun) run.fail?.(err);
  } finally {
    if (!passedRun && !errored) {
      if (cancelled) run.markCancelled?.('Cancelled — imagery prep stopped');
      else run.succeed({ ready, timedOut: pending.size });
    }
  }

  if (pending.size) {
    console.warn(`🎯 ensureDetectForProducts: ${pending.size}/${products.length} product(s) without overlay zones — proceeding (render degrades gracefully)`);
  }
  return { ensured, ready, timedOut: pending.size, total: products.length, cancelled, errored };
}

// Group products by (itemGroupId || nameNormalized(title)). Returns a
// Map<groupKey, products[]>. nameNormalized is the fallback when Meta
// doesn't expose item_group_id (some merchants don't model variants
// as groups in the catalog).
function groupProductsForDetect(products) {
  const groups = new Map();
  for (const p of products) {
    const key = p.itemGroupId
      ? `group:${p.itemGroupId}`
      : `title:${normalizeBrandName(p.title || '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

// Primary = the variant most useful to run detect on. Most images
// first (richer hero candidates, more alts), tiebreak by lowest
// externalId for determinism across re-syncs.
function pickPrimary(group) {
  return [...group].sort((a, b) => {
    const ai = (a.additionalImages || []).length;
    const bi = (b.additionalImages || []).length;
    if (bi !== ai) return bi - ai;
    return String(a.externalId).localeCompare(String(b.externalId));
  })[0];
}

// Create a DetectRun for this Media only if one isn't already in-flight.
// The DetectRun model's partial unique index on (mediaId, status in
// queued/processing) makes concurrent .create() calls hit E11000;
// we swallow that and return the existing in-flight run instead.
// Net effect: at most one in-flight DetectRun per Media, regardless of
// how many sync paths race to enqueue it.
async function createDetectRunIfAbsent(media, product) {
  try {
    return await DetectRun.create({
      advertiserId: product.advertiserId,
      brandId:      product.brandId,
      mediaId:      media._id,
      trigger:      'catalog-sync'
    });
  } catch (err) {
    if (err.code === 11000) {
      // Concurrent enqueue beat us to it. Return the existing in-flight run.
      const existing = await DetectRun.findOne({
        mediaId: media._id,
        status:  { $in: ['queued', 'processing'] }
      }).lean();
      if (existing) {
        console.log(`   · catalog-product[${product._id}] detect already enqueued for ${media._id} — skipping duplicate`);
        return existing;
      }
      return null;
    }
    throw err;
  }
}

// ── Internals ───────────────────────────────────────────────────────

// Mirror the source URL to Cloudinary (so the source's CDN expiry
// doesn't break the index later) and create a wrapper Media doc.
// Idempotent: when a Media with the synthetic externalId already
// exists (re-sync, concurrent enqueue, scheduler-overlap), return
// the existing doc instead of E11000-ing on the
// (brandId, source, externalId) unique index. Brand-scoped so a
// different brand's catalog with a coincidentally-matching synthetic
// id can't collide.
async function materializeImage({ sourceUrl, product, imageRole, feedIndex = null }) {
  const externalId = `cp_${product._id}_${imageRole}_${hashShort(sourceUrl)}`;

  // Ingest-time shot style (CatalogProduct.imageShotStyles, URL-keyed).
  // Copy onto Media.technicalInsights without re-fetch / re-sharp so
  // Media consumers see the signal immediately. Declared paths only —
  // Mongoose strict mode silently drops undeclared technicalInsights.*.
  const storedShot = technicalInsightsFromStored(
    storedStyleForUrl(product?.imageShotStyles, sourceUrl)
  );

  // Fast path — if the Media doc already exists, skip the Cloudinary
  // mirror (expensive) and return it. The mirror is best-effort
  // anyway; a prior successful pass already paid for it.
  const existing = await Media.findOne({ brandId: product.brandId, source: 'catalog-product', externalId });
  if (existing) {
    const patch = {};
    // Backfill feedIndex on a doc materialized before this field existed —
    // metadata-only, no re-mirror. Leaves an already-stamped doc alone.
    if (feedIndex != null && existing.metadata?.feedIndex == null) {
      patch['metadata.feedIndex'] = feedIndex;
      existing.metadata = existing.metadata || {};
      existing.metadata.feedIndex = feedIndex;
    }
    // First-write backfill of ingest shot style. Applies only when Media
    // has no shotStyle yet — re-classify is not reachable for already-
    // stored product URLs, so a "newer-wins / threshold retune" branch
    // would be dead code (see shouldApplyStoredShot).
    if (shouldApplyStoredShot(existing.technicalInsights, storedShot)) {
      patch['technicalInsights.shotStyle'] = storedShot.shotStyle;
      patch['technicalInsights.shotStyleConfidence'] = storedShot.shotStyleConfidence;
      patch['technicalInsights.shotStyleMetrics'] = storedShot.shotStyleMetrics;
      patch['technicalInsights.updatedAt'] = storedShot.updatedAt;
      existing.technicalInsights = {
        ...(existing.technicalInsights || {}),
        ...storedShot
      };
    }
    if (Object.keys(patch).length) {
      await Media.updateOne({ _id: existing._id }, { $set: patch });
    }
    return existing;
  }

  let mirroredUrl;
  let uploadResult = null;
  try {
    uploadResult = await uploadUrlToCloudinary(sourceUrl, {
      folder: `catalog-product/${product.brandId}`
    });
    mirroredUrl = uploadResult.secure_url || uploadResult.url;
  } catch (err) {
    // Mirroring is best-effort — fall back to the source URL if
    // Cloudinary's free tier is exhausted or the upload errored.
    // Detect can still run against the source URL.
    console.warn(`   ⚠️  Cloudinary mirror failed (${product._id} ${imageRole}): ${err.message}`);
    mirroredUrl = sourceUrl;
  }

  try {
    // Capture dimensions from the Cloudinary upload result when present
    // so the video-reference reframe path can skip outpaint when the
    // source aspect already matches the target (REFRAME_SKIP_THRESHOLD).
    const doc = {
      advertiserId: product.advertiserId,
      brandId:      product.brandId,
      source:       'catalog-product',
      externalId,
      fileType:     'image',
      fileUrl:      mirroredUrl,
      metadata: {
        catalogProductId: product._id,
        imageRole,                              // 'hero' | 'alt'
        // Position in the merchant feed: 0 = product.imageUrl, 1..N =
        // additionalImages[0..N-1] in stored order. Owner directive
        // 2026-08-05: this is the sole ordering signal for catalog seed
        // selection going forward — imageRole/createdAt/shotType are not.
        feedIndex:        feedIndex,
        brand:            product.brand || null,
        category:         product.category || null,
        productTitle:     product.title || null
      }
    };
    // Only set when present — mirror fallback path may not have dims.
    if (typeof uploadResult?.width === 'number' && uploadResult.width > 0) doc.width = uploadResult.width;
    if (typeof uploadResult?.height === 'number' && uploadResult.height > 0) doc.height = uploadResult.height;
    // Free hand-forward of ingest classification — no sharp, no fetch.
    if (storedShot) doc.technicalInsights = storedShot;
    return await Media.create(doc);
  } catch (err) {
    // Lost the race to a concurrent caller — the Media doc was
    // inserted between our findOne and create. Re-fetch and apply the
    // same storedShot backfill the normal existing-doc path applies,
    // otherwise a concurrent materialize can leave Media with no
    // shotStyle even though the product had one.
    if (err.code === 11000) {
      const raced = await Media.findOne({ brandId: product.brandId, source: 'catalog-product', externalId });
      if (!raced) return raced;
      if (shouldApplyStoredShot(raced.technicalInsights, storedShot)) {
        const patch = {
          'technicalInsights.shotStyle': storedShot.shotStyle,
          'technicalInsights.shotStyleConfidence': storedShot.shotStyleConfidence,
          'technicalInsights.shotStyleMetrics': storedShot.shotStyleMetrics,
          'technicalInsights.updatedAt': storedShot.updatedAt
        };
        await Media.updateOne({ _id: raced._id }, { $set: patch });
        raced.technicalInsights = {
          ...(raced.technicalInsights || {}),
          ...storedShot
        };
      }
      return raced;
    }
    throw err;
  }
}

// Fill in a missing imageMediaId for an existing product — the hero
// counterpart of materializeMissingAlts below, and for the same reason.
//
// Since CATALOG_DETECT_PRECOMPUTE went to false (detect deferral), no ingest
// path materializes the hero at sync time: enqueueBrandProductDetects returns
// `deferred` before it ever calls enqueueProductDetect. The pull side
// (ensureDetectForProducts) runs at AD-GENERATION time, which is strictly
// after the Step 2 picker has already rendered — so the picker saw
// imageMediaId:null and greyed the "PRIMARY" tile as "image still
// processing", forever, on a catalog that had nothing queued at all. Alts
// escaped this only because the detail endpoint already lazily backfilled
// them.
//
// Deliberately materialize ONLY — no createDetectRunIfAbsent. That keeps the
// cost profile identical to materializeMissingAlts (one Cloudinary mirror,
// idempotent via the (brandId, source, externalId) unique index) and does NOT
// re-introduce the per-product Gemini vision spend that the deferral was
// written to remove. Crops / overlay zones / ad-readiness still land later at
// ad time via ensureDetectForProducts.
//
// Returns the imageMediaId string, or null when there's nothing to
// materialize or the mirror failed. Safe to call repeatedly.
async function materializeMissingHero(product) {
  if (product.imageMediaId) return String(product.imageMediaId);
  if (!product.imageUrl) return null;

  const heroMedia = await materializeImage({
    sourceUrl: product.imageUrl,
    product,
    imageRole: 'hero'
  });
  if (!heroMedia?._id) return null;

  const heroMediaId = String(heroMedia._id);
  // Guarded write: only claim the slot if it is still empty, so a concurrent
  // enqueueProductDetect that already stamped a hero wins instead of being
  // overwritten. updateOne so we don't fight Mongoose versioning on a lean doc.
  const res = await CatalogProduct.updateOne(
    { _id: product._id, $or: [{ imageMediaId: null }, { imageMediaId: { $exists: false } }] },
    { $set: { imageMediaId: heroMediaId } }
  );
  // Lost the race — report what is actually persisted, not what we minted, so
  // the caller never hands the picker an id the document doesn't carry.
  // Returning null on a genuinely unpersisted write is deliberate: the tile
  // stays greyed for this render and the next fetch retries, which is honest.
  // Handing back a live-looking id that no CatalogProduct references would
  // make the tile selectable and then silently wrong downstream.
  if (!res?.modifiedCount) {
    const fresh = await CatalogProduct.findById(product._id).select('imageMediaId').lean();
    return fresh?.imageMediaId ? String(fresh.imageMediaId) : null;
  }
  return heroMediaId;
}

// Fill in the gaps in additionalImageMediaIds for an existing product.
// Materializes a catalog-product Media doc for every additionalImages[i]
// that doesn't yet have a corresponding entry, in parallel. Used by the
// catalog detail endpoint as a lazy backfill so the picker tile is
// always clickable (independent selection requires imageMediaId). Safe
// to call repeatedly — materializeImage is idempotent via the
// (brandId, source, externalId) unique index. No-op when nothing's
// missing. Returns the final additionalImageMediaIds array.
async function materializeMissingAlts(product) {
  const urls = Array.isArray(product.additionalImages) ? product.additionalImages : [];
  const ids  = Array.isArray(product.additionalImageMediaIds) ? product.additionalImageMediaIds : [];
  if (!urls.length) return ids;
  // Cap the lazy backfill at MAX_ALT_IMAGES so a catalog row with 50
  // alts doesn't trigger 50 Cloudinary round-trips on one detail fetch.
  const cappedUrls = urls.slice(0, MAX_ALT_IMAGES);
  // Index-aligned: keep existing ids in place, only materialize where
  // the slot is empty/missing.
  const indicesNeedingFill = [];
  for (let i = 0; i < cappedUrls.length; i++) {
    if (!cappedUrls[i]) continue;
    if (cappedUrls[i] === product.imageUrl) continue;       // dedupe against hero
    if (ids[i]) continue;
    indicesNeedingFill.push(i);
  }
  if (!indicesNeedingFill.length) return ids;

  // feedIndex must be the alt's COMPACT position among real (non-empty,
  // non-hero-duplicate) alts — 1-based, so it continues the hero's 0.
  //
  // NOT `i + 1`. `i` is the raw index into additionalImages, and this loop
  // deliberately skips holes and any entry equal to product.imageUrl, so a
  // product whose additionalImages[0] duplicates its imageUrl would number
  // its first real alt 2 here while enqueueProductDetect — which filters
  // BEFORE enumerating (`:72-77`) — numbers the same image 1. Two writers
  // disagreeing about the same image's feed position is exactly the kind of
  // silent ordering corruption feedIndex exists to prevent.
  const compactAltPos = new Map();
  let seenRealAlts = 0;
  for (let i = 0; i < cappedUrls.length; i++) {
    if (!cappedUrls[i]) continue;
    if (cappedUrls[i] === product.imageUrl) continue;
    seenRealAlts++;
    compactAltPos.set(i, seenRealAlts);   // 1-based
  }

  const results = await Promise.allSettled(
    indicesNeedingFill.map(i =>
      materializeImage({ sourceUrl: cappedUrls[i], product, imageRole: 'alt', feedIndex: compactAltPos.get(i) ?? null })
        .then(m => ({ i, mediaId: m?._id ? String(m._id) : null }))
        .catch(err => {
          console.warn(`   ⚠️  materializeMissingAlts[${product._id}][${i}]: ${err.message}`);
          return { i, mediaId: null };
        })
    )
  );
  const newIds = [...ids];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.mediaId) continue;
    newIds[r.value.i] = r.value.mediaId;
  }
  // Persist the filled-in array. updateOne so we don't fight Mongoose
  // versioning on a lean doc.
  await CatalogProduct.updateOne(
    { _id: product._id },
    { $set: { additionalImageMediaIds: newIds } }
  );
  return newIds;
}

function hashShort(s) {
  // Tiny non-crypto hash, just for distinguishing image URLs in the
  // synthetic externalId. Stable across calls so re-imports don't
  // generate new ids for the same image.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

module.exports = {
  enqueueProductDetect,
  enqueueBrandProductDetects,
  ensureDetectForProducts,
  ensureDetectRunsForExistingMedia,
  materializeMissingHero,
  materializeMissingAlts,
  // Exported for offline harnesses (verifyIngestShotClassify) — not a
  // new public product API.
  materializeImage,
  MAX_ALT_IMAGES
};
