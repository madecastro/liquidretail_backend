'use strict';
// CatalogProduct.imageUrl upsert guard.
//
// A merchant who later adds a hero (null → url) must HEAL. A feed that
// transiently returns null/empty must NOT clobber a good URL already
// stored. Incoming non-empty URL always wins (merchant replaced the
// photo). Incoming null/empty/whitespace is omitted from $set so Mongo
// leaves the previous value alone — including on insert, where the
// field simply stays unset (honest missing, same as writing null).
//
// Used by all four catalog writers. Do not `$set: { imageUrl: x || null }`.

function imageUrlPatch(incoming) {
  if (typeof incoming === 'string') {
    const trimmed = incoming.trim();
    if (trimmed) return { imageUrl: trimmed };
    return {};
  }
  if (incoming) return { imageUrl: incoming };
  return {};
}

function assignImageUrl(set, incoming) {
  if (!set || typeof set !== 'object') return set;
  const patch = imageUrlPatch(incoming);
  if (Object.prototype.hasOwnProperty.call(patch, 'imageUrl')) {
    set.imageUrl = patch.imageUrl;
  }
  return set;
}

module.exports = { imageUrlPatch, assignImageUrl };
