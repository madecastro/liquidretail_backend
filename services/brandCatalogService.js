// Brand catalog service. Opportunistic upsert called from the detect
// pipeline's product-match stage: first time we see a brand name, we create
// a stub record seeded with whatever weak signal we have (the source
// image's background palette for colors, the brand name for display).
// Later curation (real logo, canonical colors, font) lands via the
// brand-management UI.
//
// Intentionally cheap — findOneAndUpdate with $setOnInsert so existing
// brands get a no-op touch, not a color overwrite. Safe to call on every
// detect run.

const Brand = require('../models/Brand');
const { normalizeBrandName } = require('../models/Brand');

async function upsertBrandStub({ name, paletteSeed, firstSeenMediaId, websiteUrl }) {
  if (!name || typeof name !== 'string') return null;
  const normalized = normalizeBrandName(name);
  if (!normalized) return null;

  const palette = Array.isArray(paletteSeed) ? paletteSeed.filter(c => typeof c === 'string') : [];

  const stubFields = {
    name:             name.trim(),
    nameNormalized:   normalized,
    tagline:          null,
    logoUrl:          null,
    primaryColor:     palette[0] || null,
    secondaryColor:   palette[1] || null,
    accentColor:      palette[2] || null,
    fontFamily:       null,
    tone:             [],
    demographics:     [],
    source:           'stub',
    firstSeenMediaId: firstSeenMediaId || null,
    createdAt:        new Date(),
    updatedAt:        new Date()
  };

  let doc;
  try {
    doc = await Brand.findOneAndUpdate(
      { nameNormalized: normalized },
      { $setOnInsert: stubFields },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // Non-fatal — brand upsert failure should never block the detect pipeline.
    console.warn(`   ⚠️  brand upsert failed for "${name}": ${err.message}`);
    return null;
  }

  // Opportunistic website-URL attach + enrichment kick-off. We set the URL
  // on the stub the first time a user supplies it (never overwrite if the
  // brand already has one). If the Brand hasn't been enriched yet and we
  // now have a URL, run enrichment in the background — detect never waits.
  if (websiteUrl && !doc.websiteUrl && doc.source !== 'curated') {
    try {
      doc.websiteUrl = websiteUrl;
      await doc.save();
    } catch (err) {
      console.warn(`   ⚠️  brand websiteUrl save failed for "${name}": ${err.message}`);
    }
  }

  if (doc.websiteUrl && doc.source === 'stub') {
    // Fire-and-forget. Require here to avoid a circular-require at module
    // load time (enrichment service does NOT import brandCatalogService).
    const { enrichBrandFromUrl } = require('./brandEnrichmentService');
    enrichBrandFromUrl(doc._id).catch(err =>
      console.warn(`   ⚠️  brand enrichment fire-and-forget failed for "${name}": ${err.message}`)
    );
  }

  return doc;
}

async function findBrandByName(name) {
  if (!name) return null;
  const normalized = normalizeBrandName(name);
  if (!normalized) return null;
  return Brand.findOne({ nameNormalized: normalized });
}

module.exports = { upsertBrandStub, findBrandByName };
