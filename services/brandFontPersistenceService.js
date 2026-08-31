'use strict';

function normalizeFamily(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function fontKey(font) {
  return `${normalizeFamily(font?.family)}|${font?.weight || 400}|${font?.style || 'normal'}`;
}

/**
 * Merge ingest result into existing brand.customFonts.
 *
 * Invariants (adversarial-review 2026-08):
 *   1) url:null never clobbers a non-null url. A failed commercial re-ingest
 *      (flagged shape {url:null, needsLicense:true}) must not destroy a
 *      previously good mirror. Null-url candidates may still be ADDED when
 *      no keyed entry with a url exists. Last-write-wins for everything else.
 *   2) Explicit human hold: existing needsLicense:true AND non-null url is a
 *      hold on a usable face (operator-set). Successful re-ingest keeps
 *      needsLicense:true. Auto-flag shape (url:null + needsLicense:true) is
 *      NOT a human hold — only the hold-on-usable-face case is preserved.
 */
function mergeFontEntries(existing, result) {
  const merged = new Map((Array.isArray(existing) ? existing : []).map((font) => [fontKey(font), font]));
  for (const entry of [...(result?.ingested || []), ...(result?.flagged || [])]) {
    if (!entry?.family) continue;
    const key = fontKey(entry);
    const prev = merged.get(key);

    // F1: null-url candidate must never replace a good mirror.
    const candidateUrlNull = entry.url == null || entry.url === '';
    const prevHasUrl = prev && prev.url != null && prev.url !== '';
    if (candidateUrlNull && prevHasUrl) continue;

    // F3: preserve explicit human hold on a usable face.
    // Auto-flag (url:null + needsLicense:true) never qualifies as a hold —
    // that shape only lands here when no good url exists (see F1 continue).
    let next = entry;
    if (
      prev &&
      prev.needsLicense === true &&
      prev.url != null &&
      prev.url !== '' &&
      !candidateUrlNull
    ) {
      next = { ...entry, needsLicense: true };
    }

    merged.set(key, next);
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
  // Commercial mirrors are usable when BRAND_FONT_ASSUME_LICENSED is on
  // (default true) and needsLicense is not an explicit human hold.
  const assumeLicensed = String(process.env.BRAND_FONT_ASSUME_LICENSED ?? 'true').toLowerCase() !== 'false';
  const curated = Array.isArray(brand.curatedFields) && brand.curatedFields.includes('fontFamily');
  const observed = result?.usage?.heading || result?.usage?.body || null;
  const observedKey = normalizeFamily(observed);
  const usable = (brand.customFonts || []).some((font) =>
    font?.url &&
    font?.needsLicense !== true &&
    (font?.license !== 'commercial' || assumeLicensed) &&
    normalizeFamily(font.family) === observedKey
  );
  if (!curated && brand.fontSource !== 'tailwind' && observed && usable) {
    brand.fontFamily = observed;
    brand.fontSource = 'website';
  }
  return brand;
}

/**
 * Persist a metaAdsFontService result. Deliberately NARROWER than
 * applyFontIngestResult: it writes the observation and the attempt stamp, and
 * that is all.
 *
 * It does NOT touch fontFamily/fontSource. The website path may promote,
 * because it promotes a family whose FILE we hold. This path only holds a NAME
 * a vision model read off a JPEG — writing it into fontFamily would put a guess
 * into the field the whole resolver treats as the brand's scanned face, ahead of
 * a curated theme. The name reaches resolution through the ladder's exact-only
 * tier instead, where it must resolve to a real file to win anything.
 *
 * `metaFontsIngestedAt` is a MONEY-GATED stamp, not a plain "we looked" mark —
 * CORRECTED, this used to be unconditional. It must be set on a genuine paid
 * result (a vision call was invoked, or an Apify run was submitted) so a
 * coverage backfill does not re-pay for a brand whose ads truly could not be
 * read. It must NOT be set when `result.billableAttempted` is false — that
 * means every reachable tier came back for free (no Meta credential
 * connected, APIFY_ADLIB_ACTOR unset, a connected account with zero
 * creatives, …), so nothing was spent and nothing should be permanently
 * disabled. Measured 2026-08-31: all 9 brands in production were stamped
 * done from exactly this branch despite zero vision calls ever having run,
 * which meant connecting Meta Ads or configuring Apify later would never
 * re-trigger the scan for any of them. The `error` override param (used by a
 * caller that caught a genuine exception of its own) always stamps — an
 * explicit caller-supplied error is assumed to mean the caller already
 * decided a billable attempt happened.
 */
function applyMetaFontsResult(brand, result, { error = null } = {}) {
  brand.metaAdsFontUsage = result?.usage || brand.metaAdsFontUsage || null;
  const priorErrors = result?.errors?.length ? result.errors.join('; ').slice(0, 2000) : null;
  brand.metaFontsIngestError = error || priorErrors;
  if (error || result?.billableAttempted) {
    brand.metaFontsIngestedAt = new Date();
  }
  // else: nothing billable was attempted — leave metaFontsIngestedAt as-is
  // (unset, or whatever it already was) so the NEXT enrichment run retries
  // for free the moment config changes. The error string above still records
  // WHY, for ops visibility, without blocking the retry.
  brand.markModified?.('metaAdsFontUsage');
  return brand;
}

module.exports = {
  normalizeFamily,
  mergeFontEntries,
  applyMetaFontsResult,
  applyFontIngestResult
};
