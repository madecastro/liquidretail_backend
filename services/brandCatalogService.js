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

async function upsertBrandStub({ name, paletteSeed, firstSeenMediaId }) {
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
    source:           'stub',
    firstSeenMediaId: firstSeenMediaId || null,
    createdAt:        new Date(),
    updatedAt:        new Date()
  };

  try {
    const doc = await Brand.findOneAndUpdate(
      { nameNormalized: normalized },
      { $setOnInsert: stubFields },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return doc;
  } catch (err) {
    // Non-fatal — brand upsert failure should never block the detect
    // pipeline. Just log and move on.
    console.warn(`   ⚠️  brand upsert failed for "${name}": ${err.message}`);
    return null;
  }
}

async function findBrandByName(name) {
  if (!name) return null;
  const normalized = normalizeBrandName(name);
  if (!normalized) return null;
  return Brand.findOne({ nameNormalized: normalized });
}

module.exports = { upsertBrandStub, findBrandByName };
