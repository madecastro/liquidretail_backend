'use strict';

function normalizeFamily(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function fontKey(font) {
  return `${normalizeFamily(font?.family)}|${font?.weight || 400}|${font?.style || 'normal'}`;
}

function mergeFontEntries(existing, result) {
  const merged = new Map((Array.isArray(existing) ? existing : []).map((font) => [fontKey(font), font]));
  for (const entry of [...(result?.ingested || []), ...(result?.flagged || [])]) {
    if (entry?.family) merged.set(fontKey(entry), entry);
  }
  return [...merged.values()];
}

function applyFontIngestResult(brand, result, { error = null } = {}) {
  brand.customFonts = mergeFontEntries(brand.customFonts, result);
  brand.websiteFontUsage = result?.usage || brand.websiteFontUsage || null;
  brand.fontIngestedAt = new Date();
  brand.fontIngestError = error || (result?.errors?.length ? result.errors.join('; ').slice(0, 2000) : null);
  brand.markModified?.('customFonts');
  brand.markModified?.('websiteFontUsage');

  // Promote the observed website heading family only when it corresponds
  // to a usable mirrored face. Human curation and Tailwind remain above
  // every inferred/observed automatic source.
  const curated = Array.isArray(brand.curatedFields) && brand.curatedFields.includes('fontFamily');
  const observed = result?.usage?.heading || result?.usage?.body || null;
  const observedKey = normalizeFamily(observed);
  const usable = (brand.customFonts || []).some((font) =>
    font?.url &&
    font?.license !== 'commercial' &&
    normalizeFamily(font.family) === observedKey
  );
  if (!curated && brand.fontSource !== 'tailwind' && observed && usable) {
    brand.fontFamily = observed;
    brand.fontSource = 'website';
  }
  return brand;
}

module.exports = {
  normalizeFamily,
  mergeFontEntries,
  applyFontIngestResult
};
