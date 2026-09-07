// ⚠️ MINT-TIME / REGENERATE TITLING OF NEW ADS RUNS IN ADGEN, NOT HERE.
//
// This backend copy is LIVE only for preview / debug / ops:
//   - POST /api/brand/:id/render-script   (routes/brand.js)
//   - POST /api/brand/:id/title-still
//   - POST /api/brand/:id/preview-script
//   - scripts/retitleDriver.js (SSH-invoked ops)
//   - GET ads generation-inspector reconstruction (buildMetaForAd only)
//
// Batch retitle (POST /:id/retitle-videos) stamps Ad.retitleRequest and
// returns; adgen/src/services/retitleConsumer.js executes via adgen's
// own copy of this file. New-generate and regenerate titling:
// adgen/src/services/brandScriptExecutor.js (renderer + titler +
// regenerateConsumer). Do not "fix regenerate Cloudinary cleanup" here
// — that lives in adgen's uploadRenderAndStamp.
//
// Canvas VM runner (brandScriptRunner.child.js) is deleted.
// resolveTitlingEngine returns 'remotion' unconditionally.

const path = require('path');
const { usableAttribution } = require('./quoteProvenance');

// Live font cache dir (fontLoader / fontResolverService). Canvas VM
// runner deleted (STRIP-INVENTORY PR-B2); this path is not a spawn target.
const FONTS_DIR = path.join(__dirname, 'brandScripts', 'assets', 'fonts');

// ── Format classifier ──────────────────────────────────────────────
//
// Three format buckets:
//   vertical   — 9:16 (Reels, Shorts, Stories)   → top_scrim_editorial
//   landscape  — 16:9 (pmax, YouTube pre-roll)   → local_scrim_landscape
//   feed       — 4:5 / 1:1 (Meta feed, catchall) → canonical
//
// Format ID string is authoritative when present; aspectRatio is a
// fallback for legacy ads whose platformFormat wasn't stamped.
function isVerticalFormat(ad) {
  const pf = String(ad?.platformFormat || '').toLowerCase();
  if (/reels|shorts|stories|9_16/.test(pf)) return true;
  if (String(ad?.aspectRatio || '') === '9:16') return true;
  return false;
}

function isLandscapeFormat(ad) {
  const pf = String(ad?.platformFormat || '').toLowerCase();
  // Bare `pmax` used to be enough when the only Google key was pmax_16_9.
  // Square/portrait PMax keys now exist — match landscape by 16_9 (and the
  // explicit landscape slug), not every pmax_* id. preroll/youtube kept.
  if (/pmax_landscape|preroll|youtube|16_9/.test(pf)) return true;
  if (String(ad?.aspectRatio || '') === '16:9') return true;
  return false;
}

// 1:1 (Meta Feed square, PMax square image/video). Anchored to the `_1_1`
// SUFFIX rather than a loose /1_1/ so it cannot collide with another format id
// that merely contains those digits. Checked against the real ids:
// meta_feed_1_1 / pmax_square_1_1 / pmax_video_1_1 match; meta_feed_4_5,
// meta_reels_9_16, meta_stories_9_16 and pmax_16_9 do not.
function isSquareFormat(ad) {
  const pf = String(ad?.platformFormat || '').toLowerCase();
  if (/_1_1$/.test(pf)) return true;
  if (String(ad?.aspectRatio || '') === '1:1') return true;
  return false;
}

// BUG FIXED 2026-07-29: this was a three-way branch ending in `return 'feed'`, so a
// 1:1 ad matched neither vertical nor landscape and fell through to 'feed' — titled
// in CanonicalFeed at 1080x1350. Since BasePlate uses objectFit:'cover', a 1:1 ad was
// centre-cropped into a 4:5 frame and delivered at 4:5 while its Ad row said
// aspectRatio '1:1'. meta_feed_1_1 declares kinds ['image','video'] and AI_VEO_FEED
// is true, so this was reachable, not theoretical.
//
// Order matters: vertical first (9_16 is specific); square BEFORE landscape so
// pmax_video_1_1 / pmax_square_1_1 are not swallowed by a landscape rule that
// once matched every `pmax_*` id; pmax_portrait_4_5 then falls through to feed.
function classifyFormat(ad) {
  if (isVerticalFormat(ad))  return 'vertical';
  if (isSquareFormat(ad))    return 'square';
  if (isLandscapeFormat(ad)) return 'landscape';
  return 'feed';
}

// Which Brand field holds the per-format custom script. One row per
// format so adding a fourth is one line.
const BRAND_SCRIPT_FIELD = {
  vertical:  'styleScriptVertical',
  landscape: 'styleScriptLandscape',
  // square shares feed's custom-script field and feed's canonical script: same 1080
  // width, same surface, only the height differs. A dedicated styleScriptSquare would
  // be one row here plus one in routes/brand.js's preview-script map.
  square:    'styleScript',
  feed:      'styleScript'
};

// ── Public API ─────────────────────────────────────────────────────

// Canvas VM runner deleted (STRIP-INVENTORY PR-B2). Fail-closed: a
// caller that still reaches this (CLI --engine=canvas, or resolveTitlingEngine
// un-hardwired) must not spawn a missing child or ENOENT a deleted script.
async function renderBrandScript() {
  const e = new Error("canvas titling retired — titling is Remotion (Title Studio)");
  e.status = 410;
  throw e;
}

// ── High-level helpers ─────────────────────────────────────────────

// Defence in depth for video chrome — same dual-gate as
// directImageRenderService.buildIntentData. layoutInputService already
// withholds non-printable quotes at pool assembly, so this should rarely
// fire. It exists because a LayoutInputArtifact cached BEFORE the
// producer-side provenance gate landed can still carry a fabricated
// primary_quote, and the cascade engine is path-blind: it only ever sees
// .text / .snippet / .author, never origin. Without this re-check,
// Remotion burns that claim into delivered video chrome.
//
// Local clone only — never mutates the artifact document. Dropping the
// quote degrades the slot to absent; this must never throw (Atlas video
// is already billed by the time titling runs). ONE gate
// (quoteProvenance.toPrintableCustomerQuote); do not invent a second
// allowlist that can drift from static.
//
// ALWAYS reseats primary_quote with the gate's return value when admitting.
// That is load-bearing for llm-web: those quotes print as TEXT ONLY, and
// the strip of author_name/author/source happens inside toPrintable so a
// cached artifact carrying "vertexaisearch.cloud.google.com" as author
// cannot reach metaCascadeConfig's reviewer cascade.
//
// Pure + exported so the offline harness can drive the real production
// path without Mongo. Call site in buildMetaForAd is the live wire.
function gateLayoutInputQuotes(layoutInput, scope = {}) {
  try {
    const pq = layoutInput?.input?.social_proof?.primary_quote;
    if (!pq) return layoutInput;
    const { toPrintableCustomerQuote, applyStrictQuoteScope } = require('./quoteProvenance');
    const { applyQuoteColourway } = require('./quoteColourway');
    let printable = toPrintableCustomerQuote(pq);
    let withheldByStrict = false;
    let withheldByColourway = false;
    if (printable) {
      const scoped = applyStrictQuoteScope(printable, scope);
      if (!scoped) {
        const rest = Array.isArray(layoutInput?.input?.social_proof?.secondary_quotes)
          ? layoutInput.input.social_proof.secondary_quotes : [];
        let rescued = null;
        for (const cand of rest) {
          const next = applyStrictQuoteScope(toPrintableCustomerQuote(cand), scope);
          if (next) { rescued = next; break; }
        }
        if (rescued) {
          console.log(
            `🔒 brandScript: brand-pool quote failed product-scope — using next allowed candidate`
          );
          printable = rescued;
        } else {
          withheldByStrict = true;
          printable = null;
        }
      } else {
        printable = scoped;
      }
    }
    if (printable) {
      const colourOk = applyQuoteColourway(printable, scope);
      if (!colourOk) {
        const rest = Array.isArray(layoutInput?.input?.social_proof?.secondary_quotes)
          ? layoutInput.input.social_proof.secondary_quotes : [];
        let rescued = null;
        for (const cand of rest) {
          const next = applyQuoteColourway(
            applyStrictQuoteScope(toPrintableCustomerQuote(cand), scope),
            scope
          );
          if (next) { rescued = next; break; }
        }
        if (rescued) {
          console.log(
            `🔒 brandScript: quote failed colourway — using next allowed candidate`
          );
          printable = rescued;
        } else {
          withheldByColourway = true;
          printable = null;
        }
      } else {
        printable = colourOk;
      }
    }
    if (!printable) {
      console.log(
        withheldByColourway
          ? `🔒 brandScript: quote withheld (colourway mismatch) — titling with no testimonial`
          : withheldByStrict
          ? `🔒 brandScript: quote withheld (QUOTE_PROVENANCE_STRICT ` +
            `tier=${pq.tier || 'unstamped'}) — titling with no testimonial`
          : `🔒 brandScript: quote withheld (tier=${pq.tier || 'unstamped'} ` +
            `origin=${pq.origin || 'unstamped'}) — titling with no testimonial`
      );
      return {
        ...layoutInput,
        input: {
          ...layoutInput.input,
          social_proof: {
            ...layoutInput.input.social_proof,
            primary_quote: null
          }
        }
      };
    }
    // Reseat even when the quote was already clean: the gate's copy is the
    // only object cascade is allowed to read, so llm-web bylines stay gone.
    return {
      ...layoutInput,
      input: {
        ...layoutInput.input,
        social_proof: {
          ...layoutInput.input.social_proof,
          primary_quote: printable
        }
      }
    };
  } catch (err) {
    // Prefer a thinner ad over a crash after a billed Omni submit, and
    // over accidentally shipping a quote we could not validate.
    console.warn(`🔒 brandScript: quote gate error (${err.message}) — withholding`);
    if (!layoutInput?.input?.social_proof) return layoutInput;
    return {
      ...layoutInput,
      input: {
        ...layoutInput.input,
        social_proof: {
          ...layoutInput.input.social_proof,
          primary_quote: null
        }
      }
    };
  }
}

// Merchandising qualifiers that describe WHO a product is for, not WHAT it
// is — the ad already carries the brand's own audience elsewhere, so on the
// close-phase product-name slot they are pure overhead. Plural/possessive
// forms ONLY ("Women's", "Kids", "Mens") — bare singular words ("Men",
// "Boy") are deliberately excluded because they collide with ordinary
// English inside a real product name ("Men in Black", "Girl Scout"). This
// list is brand- and category-agnostic: it only ever fires on an exact
// leading token, never mid-string, so it is inert for the vast majority of
// titles that don't open with one of these words.
const GENDER_QUALIFIER_PREFIXES = [
  "women's", 'womens',
  "men's", 'mens',
  "kids'", 'kids',
  "girls'", 'girls',
  "boys'", 'boys',
  "toddler's", 'toddlers',
  "ladies'", 'ladies',
  'unisex',
];

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest-first so "kids'" is tried before the shorter "kids" alternative
// would otherwise win and swallow the apostrophe form's plain match first.
const GENDER_QUALIFIER_RE = new RegExp(
  `^(${GENDER_QUALIFIER_PREFIXES
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})\\s+`,
  'i'
);

/**
 * Strip a leading gender/audience qualifier ("Women's", "Kids", …) when it
 * reads as a merchandising prefix, not part of the brand's own identity.
 * Guarded: if the brand's own name starts with that same word (a brand
 * literally called "Women's Health"), the qualifier is load-bearing — leave
 * it alone. Never empties the string.
 */
function stripLeadingGenderQualifier(name, brandName) {
  const match = name.match(GENDER_QUALIFIER_RE);
  if (!match) return name;
  const qualifier = match[1].toLowerCase();
  const brand = brandName ? String(brandName).trim().toLowerCase() : '';
  if (brand) {
    const bare = qualifier.replace(/'/g, '');
    if (brand === qualifier || brand === bare
      || brand.startsWith(`${qualifier} `) || brand.startsWith(`${bare} `)) {
      return name;
    }
  }
  const rest = name.slice(match[0].length).trim();
  return rest || name;
}

function normalizeWordForCompare(w) {
  let s = String(w).toLowerCase();
  // Strip surrounding punctuation (quotes, trailing period/comma, …) but
  // NOT an internal apostrophe yet — "women's" needs it for the next step.
  s = s.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
  s = s.replace(/'s$/, ''); // possessive suffix only, never a bare plural "s"
  return s;
}

// How many LEADING words of `nameWords` match `brandWords` word-for-word
// (case-insensitive, possessive-insensitive). Stops at the first mismatch;
// a brand longer than what's left in the title can never fully match.
function countLeadingWordMatch(nameWords, brandWords) {
  let matched = 0;
  for (let i = 0; i < brandWords.length && i < nameWords.length; i++) {
    const a = normalizeWordForCompare(brandWords[i]);
    const b = normalizeWordForCompare(nameWords[i]);
    if (!a || a !== b) break;
    matched++;
  }
  return matched;
}

/**
 * Strip a leading brand-name token when the ad already carries that exact
 * brand elsewhere (logo / brand-name slot) and the catalog title repeats it
 * as its first word(s) — e.g. "Vuori Vintage Oversized Denim Jacket" under
 * Vuori's own brand becomes "Vintage Oversized Denim Jacket".
 *
 * Word-by-word prefix match (not a single substring match): consumes as
 * many of the brand name's words as the title actually opens with, then
 * stops. This deliberately tolerates a brand name that is LONGER than what
 * the title repeats — e.g. a test/demo tenant named "Vuori 2" still strips
 * the catalog "Vuori " prefix from a title that (correctly) never says "2".
 * A brand whose own name opens with "The" ("The Ordinary") matches directly;
 * one that doesn't ("North Face") still matches after a title's OWN leading
 * "The " (only tried when the direct match found nothing, so it never
 * double-strips a brand that already starts with "The").
 *
 * Whole-word only (never a partial/substring match) — a brand word that
 * merely happens to prefix an unrelated title word never fires. Never
 * empties the string: matching every word in the title leaves it untouched.
 */
function stripLeadingBrandToken(name, brandName) {
  const brand = brandName ? String(brandName).trim() : '';
  if (!brand) return name;
  const nameWords = name.trim().split(/\s+/);
  const brandWords = brand.split(/\s+/);
  if (!nameWords.length || !brandWords.length) return name;

  let offset = 0;
  let matched = countLeadingWordMatch(nameWords, brandWords);
  if (matched === 0 && /^the$/i.test(nameWords[0]) && !/^the$/i.test(brandWords[0])) {
    offset = 1;
    matched = countLeadingWordMatch(nameWords.slice(1), brandWords);
  }
  if (matched === 0) return name;

  const consumed = offset + matched;
  if (consumed >= nameWords.length) return name;
  const rest = nameWords.slice(consumed).join(' ').trim();
  return rest || name;
}

/**
 * Strip leading gender-qualifier and redundant own-brand tokens, in
 * whichever order they appear in the source title ("Women's Vuori …" or
 * "Vuori Women's …"). Two passes is enough to catch both prefixes; a pass
 * that changes nothing stops the loop early.
 */
function stripLeadingMerchandisingTokens(name, brandName) {
  let out = name;
  for (let i = 0; i < 2; i++) {
    const next = stripLeadingBrandToken(stripLeadingGenderQualifier(out, brandName), brandName);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Clean a catalog product title for on-screen DISPLAY.
 * Order: trailing parenthetical → pipe-suffix → trailing " - X" segment
 * (dash only when remainder is ≥2 words or ≥8 chars so short names like
 * "Mach 5 - Turbo" keep their integral dash) → leading gender qualifier /
 * redundant own-brand token (see stripLeadingMerchandisingTokens — a name
 * like "Women's Vuori Vintage Oversized Denim Jacket" under the Vuori brand
 * becomes "Vintage Oversized Denim Jacket": the ad already carries Vuori
 * branding elsewhere, and "Women's" is a merchandising facet, not part of
 * what the shopper is looking at). productNameFull is always the untouched
 * raw input. Returns { productName, productNameFull }. Exported for the
 * verify harness.
 *
 * @param {string|null} name  raw catalog/cascade product title
 * @param {string|null} [brandName]  the ad's own brand name (cascaded.brandName)
 *   — optional; omitted/null keeps every pre-existing caller byte-identical
 *   for the brand-token step (the gender-qualifier step still applies, since
 *   it needs no brand context to be safe).
 */
function cleanProductNameForDisplay(name, brandName = null) {
  if (name == null) return { productName: null, productNameFull: null };
  const full = String(name).replace(/\s+/g, ' ').trim();
  if (!full) return { productName: null, productNameFull: null };
  let cleaned = full;
  // 1) Strip one or more trailing "(…)" segments (colorways, sole, pack size).
  while (/\s*\([^)]*\)\s*$/.test(cleaned)) {
    cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
  }
  // 2) Strip everything from the first " | " onward (fit notes, SKU tail).
  const pipeIdx = cleaned.indexOf(' | ');
  if (pipeIdx > 0) {
    cleaned = cleaned.slice(0, pipeIdx).replace(/\s+/g, ' ').trim();
  }
  // 3) Strip a trailing " - X" segment only when what remains is still a
  // real product name: ≥2 words AND ≥8 chars. Either gate alone is not
  // enough — "Mach 5 - Turbo" (2 words, 6 chars) must keep its dash;
  // "Women's Breezer Point - Warm Red" (3 words, 21 chars) strips.
  const dashMatch = cleaned.match(/^(.*?)(\s+-\s+.+)$/);
  if (dashMatch) {
    const head = dashMatch[1].replace(/\s+/g, ' ').trim();
    const wordCount = head ? head.split(/\s+/).length : 0;
    if (head && wordCount >= 2 && head.length >= 8) {
      cleaned = head;
    }
  }
  // 4) Strip a leading gender qualifier and/or redundant own-brand token —
  // see stripLeadingMerchandisingTokens. This is what closes the truncation
  // defect: shortening the SOURCE string beats clamping a still-long one.
  cleaned = stripLeadingMerchandisingTokens(cleaned, brandName);
  if (!cleaned) cleaned = full;
  return { productName: cleaned, productNameFull: full };
}

// Build the text-var meta object that a brand script sees. Pulls
// preferred fields from ad.copy first, then falls back to the ad's
// LayoutInputArtifact bundle if present. Called by both the initial
// pipeline (routes/ads.js Veo path) and the manual trigger endpoint
// (routes/brand.js) so meta shape stays consistent.
//
// opts.presetOverride — explicit CLI/operator named preset (TIER 0).
// opts.intentPreset — funnel-stage default floor (TIER 2.5), NOT a
// whole-spec replace. renderWithRemotionAndSave passes the same pair so
// the quote-slot bind list cannot desync from the composition. When
// intentPreset is omitted, derived from ad.funnelStage so a solo
// buildMetaForAd call still matches.
async function buildMetaForAd(ad, brand, opts = {}) {
  // Load raw context docs. Every non-derived meta field is resolved
  // downstream by the cascade engine (services/metaCascadeResolver.js)
  // against these docs + any Brand.metaCascades overrides. Brands
  // without overrides produce byte-identical output to the prior
  // hardcoded logic (each cascade in metaCascadeConfig.js mirrors the
  // exact priority order that used to live inline here).
  let layoutInput = null;
  try {
    const LayoutInputArtifact = require('../models/LayoutInputArtifact');
    const { INPUT_SCHEMA_VERSION } = require('./layoutInputService');
    // productId must be part of the match: on media carrying several
    // products, the createdAt race can hand this ad ANOTHER product's
    // copy/quote. LayoutInputArtifact.productId defaults to `null` (never
    // undefined — see models/LayoutInputArtifact.js), so `ad.productId ||
    // null` matches both a real id and the legacy/no-product artifacts —
    // same shape atlasVideoService.js already re-reads with.
    //
    // Schema freshness is a PREFERENCE, not a filter. Requiring
    // schemaVersion === INPUT_SCHEMA_VERSION in the query looks safer but is
    // a regression: 722 of 738 production artifacts are pre-4.1, and TEN meta
    // fields take layoutInput as their FIRST cascade source — including
    // `rating` and `reviewCount` themselves, plus deliveryLine, badgeText,
    // badges, benefits, productDescription. Dropping a stale artifact
    // outright would thin the canonical close phase AND delete the very
    // stars this change exists to restore.
    // It buys nothing either: the stale artifact's only unsafe field is the
    // unstamped primary_quote, and gateLayoutInputQuotes (below) already
    // withholds exactly that — 161 checks in verifyQuoteProvenance.js pin it.
    // So: prefer a current-schema artifact, fall back to the newest stale one,
    // and log which we served so a thin proof beat is diagnosable from Render
    // logs without a DB query.
    const productIdKey = ad.productId || null;
    // Stage is NOT a lookup dimension. Funnel retitles share the
    // master's {mediaId, productId} artifact (they never call
    // buildLayoutInput). A hash-aware find would miss and fall back
    // to this same unstaged row. applyStagedQuotePick reseats the
    // quote from the stored pool after load.
    const scope = { mediaId: ad.mediaId, productId: productIdKey };
    layoutInput = await LayoutInputArtifact.findOne({
      ...scope,
      schemaVersion: INPUT_SCHEMA_VERSION
    }).sort({ createdAt: -1 }).lean();

    if (!layoutInput) {
      layoutInput = await LayoutInputArtifact.findOne(scope).sort({ createdAt: -1 }).lean();
      console.log(
        layoutInput
          ? `📐 buildMetaForAd[ad=${ad._id}]: layoutInput STALE (schemaVersion=${layoutInput.schemaVersion || 'unstamped'} ` +
            `want=${INPUT_SCHEMA_VERSION}) — serving non-quote fields; quote withheld by the provenance gate. Re-derive to restore it.`
          : `📐 buildMetaForAd[ad=${ad._id}]: no layoutInput for (mediaId=${ad.mediaId} productId=${productIdKey}) — degrading to ad.copy`
      );
    }
  } catch (err) {
    // Prefer a thinner ad over a crash — Atlas video is already billed by
    // the time titling runs.
    console.log(`buildMetaForAd[ad=${ad._id}]: layoutInput lookup failed (${err.message}) — degrading to ad.copy`);
  }

  // Video dual-gate: strip non-printable primary_quote before cascade.
  // QUOTE_PROVENANCE_STRICT (flag-off identity) noun-checks a brand-pool
  // quote against THIS ad's seed Media labels when no product is attached.
  // Load the label fields only — same inexpensive select the static
  // renderer uses for scope.
  let scopeMedia = null;
  if (ad.mediaId) {
    try {
      const { loadQuoteScopeMedia } = require('./quoteProvenance');
      scopeMedia = await loadQuoteScopeMedia(ad.mediaId);
    } catch { /* seed labels optional; gate still has product name */ }
  }
  // QUOTE_STAGE_AWARE: re-pick primary_quote from the stored pool
  // BEFORE the provenance gate so the gate still has the final word.
  // Flag-off / no stage is an identity. Funnel retitles (the only
  // rows that historically carried Ad.funnelStage) land here and
  // never call buildLayoutInput.
  //
  // ORDER vs VIDEO_QUOTE_ROTATION (#195, the rotation block below):
  // the stage pick runs FIRST, then rotation may move off it if a
  // sibling in the same run already used that line. Rotation refuses
  // anything the gate would drop, so neither flag can lose a
  // testimonial the other would have printed. The single
  // gateLayoutInputQuotes call still sits after both.
  if (layoutInput?.input) {
    try {
      const { applyStagedQuotePick, resolveQuoteAssemblyOptions } = require('./layoutInputService');
      const quoteAssembly = await resolveQuoteAssemblyOptions(ad);
      const stagedInput = applyStagedQuotePick(layoutInput.input, quoteAssembly);
      if (stagedInput !== layoutInput.input) {
        layoutInput = { ...layoutInput, input: stagedInput };
        console.log(
          `📐 buildMetaForAd[ad=${ad._id}]: staged quote pick ` +
          `funnel=${quoteAssembly.funnelStage || '-'} ` +
          `"${String(stagedInput.social_proof?.primary_quote?.text || '').slice(0, 48)}"`
        );
      }
    } catch (err) {
      console.warn(`   ⚠️  buildMetaForAd[ad=${ad?._id}]: staged quote pick failed (${err.message}) — keeping stored primary`);
    }
  }

  let catalogProduct = null;
  if (ad.productId) {
    try {
      const CatalogProduct = require('../models/CatalogProduct');
      // titleStyleSpec + categoryRef are not consumed for copy/rating here —
      // they're read below only to reproduce, byte-for-byte, the SAME
      // titleSpecService.resolveSpec() call renderWithRemotionAndSave makes
      // moments after this function returns, so renderedQuoteText reflects
      // the spec that will actually be resolved for this ad's render.
      // `productReviews` is the container BOTH review writers actually fill —
      // productReviewsScrapeService (vendor APIs + headless, via
      // catalogProductReviewRefreshService) and the automatic Gemini gap-fill
      // (maybeFetchProductReviewsCached, called on catalog sync by
      // catalogProductEnrichmentService). It holds rating and reviewCount
      // written TOGETHER, which is exactly the atomic pair this function needs.
      //
      // `reviewCount` USED TO BE SELECTED HERE AND IS NOT A SCHEMA PATH.
      // models/CatalogProduct.js declares top-level `rating` (:161) and NO
      // top-level `reviewCount` — verified against the live schema. Mongoose
      // `.select()` of a non-existent path is SILENT, so `catalogProduct
      // .reviewCount` was permanently `undefined`: every product-tier video ad
      // rendered stars with NO review count, and because the old
      // `catalogHasRatingOrCount` then still saw `rating`, the layoutInput
      // fallback below never ran either, so the count was unreachable from any
      // source. Same silent-`.select()` class as the Brand `description` bug —
      // now pinned for CatalogProduct too by scripts/verifyBrandFieldNames.js.
      //
      // recentQuoteKeys + lastQuoteRunId + lastQuoteFingerprint: rotation
      // memory (QUOTE_ROTATION_MEMORY). Loaded here so rotation can run
      // BEFORE the provenance gate, matching the static path. MUST stay
      // declared on catalogProductSchema. lastQuoteFingerprint is the
      // replay key — siblings must not re-hash a different-length pool.
      // shortBenefits: same CatalogProduct field the static Director reads.
      // Without it the cascade's catalogProduct.shortBenefits source is
      // permanently undefined (silent .select() omission) and video falls
      // through to a stale LayoutInputArtifact.
      catalogProduct = await CatalogProduct.findById(ad.productId).select('title description price rating productReviews imageUrl titleStyleSpec categoryRef recentQuoteKeys lastQuoteRunId lastQuoteFingerprint shortBenefits').lean();
    } catch { /* optional */ }
  }

  // VIDEO_QUOTE_ROTATION (default false): same helper static uses, same
  // same-tier + quality-floor + render-gate guards. Flag-off returns the
  // input object unchanged — byte-identity for the path that has always
  // burned primary_quote.snippet. Rotate BEFORE the gate so the gate still
  // has the final word; rotation itself refuses lines the gate would drop
  // so flag-on cannot lose a testimonial flag-off would have printed.
  //
  // colourwayTitle is ONE value shared by rotation and paint. Catalog
  // title first (raw pipe form); display-normalized layoutInput name
  // is the fallback. Paint used to drop the catalog title, so the two
  // sites could disagree on a colourway after display-normalize
  // flattened `|` to ` - `.
  const colourwayTitle = catalogProduct?.title
    || layoutInput?.input?.product?.name
    || null;
  {
    const rot = require('./quoteRotationService');
    const runId = rot.campaignRunIdFromAd(ad);
    const rotateScope = {
      productAttached: !!ad.productId,
      productTitle: colourwayTitle,
      extraText: layoutInput?.input?.product?.name || null,
      media: scopeMedia
    };
    layoutInput = rot.rotateLayoutInputQuote(layoutInput, runId, {
      recentKeys: catalogProduct?.recentQuoteKeys,
      lastRunId: catalogProduct?.lastQuoteRunId,
      lastFingerprint: catalogProduct?.lastQuoteFingerprint,
      scope: rotateScope
    });
    const rotation = layoutInput && layoutInput._quoteRotation;
    if (catalogProduct && (catalogProduct._id || ad.productId) && runId
        && rotation && rotation.poolSize >= 2 && rotation.fingerprint && !rotation.lockedSameRun) {
      rot.persistQuoteChoice(catalogProduct._id || ad.productId, {
        fingerprint: rotation.fingerprint,
        campaignRunId: runId,
        wrapped: rotation.wrapped
      });
    }
    if (layoutInput && layoutInput._quoteRotation) delete layoutInput._quoteRotation;
  }

  layoutInput = gateLayoutInputQuotes(layoutInput, {
    productAttached: !!ad.productId,
    productTitle: colourwayTitle,
    extraText: layoutInput?.input?.product?.name || null,
    media: scopeMedia
  });

  // Catalog media list — the productOnlyImageUrl cascade reads from
  // the pre-picked `catalogMediaProductOnly` context doc (first Media
  // with classification.shotType === 'product_only'). buildContext
  // does the picking, so the cascade config stays declarative.
  let catalogMedias = [];
  if (ad.productId) {
    try {
      const Media = require('../models/Media');
      catalogMedias = await Media.find({
        source: 'catalog-product',
        'metadata.catalogProductId': ad.productId
      }).select('_id fileUrl classification metadata').lean();
    } catch { /* optional — endcard degrades to text-only */ }
  }

  // IG credential — only queried when the brand name is missing, so
  // the extra Mongo read is skipped for the common case. Loaded once
  // here so the cascade doesn't have to know about async lookups.
  let igCredential = null;
  if (!brand?.name && brand?._id) {
    try {
      const IntegrationCredential = require('../models/IntegrationCredential');
      igCredential = await IntegrationCredential
        .findOne({ brandId: brand._id, type: 'instagram', status: 'active' })
        .select('igUsername')
        .lean();
    } catch { /* optional */ }
  }

  // Cascade resolution — merge the shipped defaults with any brand-
  // authored overrides (Brand.metaCascades) and resolve every field
  // against the loaded context.
  const {
    resolveMeta, mergeCascades, buildContext,
    DEFAULT_META_CASCADES,
  } = require('./metaCascadeResolver');
  const context = buildContext({ ad, brand, catalogProduct, layoutInput, catalogMedias, igCredential });
  const merged  = mergeCascades(DEFAULT_META_CASCADES, brand?.metaCascades || null);
  const cascaded = resolveMeta(merged, context);

  // ── PMax funnel variants must not be cosmetic re-skins, AND the headline
  // must actually FIT the surface it renders on ─────────────────────────
  // The three free retitles (awareness / consideration / conversion) all
  // resolve against the SAME LayoutInputArtifact, because buildMetaForAd
  // scopes that lookup by {mediaId, productId} with no stage dimension. So
  // every variant printed the same headline and differed only in preset
  // styling — precisely what the Director prompt forbids in as many words:
  // "the three stages must each appear exactly once so Google has distinct
  // approaches to test — not cosmetic variations of one ad."
  //
  // The distinct copy already existed. A PMax round is REQUIRED to spread
  // the three stages across its three concepts, each with its own copy
  // block; nothing ever asked for it by stage. This asks.
  //
  // SECOND, SEPARATE reason to look for a better candidate — added
  // 2026-08-20, same site, because it needs the identical machinery
  // (resolveVideoHeadlineCandidates + selectVideoHeadline). The `headline`
  // slot has NO shortening step analogous to productName's
  // cleanProductNameForDisplay/fitProductNameToCap (PR #254) — it is
  // Director/layoutInput prose, not "[modifiers][noun]" shaped, so dropping
  // leading/trailing words would change its meaning, not just its length.
  // Left alone, `resolveSlotContentCore` clamps it with plain
  // `truncateWordSafe` — a mid-sentence tail-ellipsis — on any surface whose
  // real render-time cap (`deriveCharCap`, format+platformFormat+safe-zone
  // aware) is smaller than the cascade's raw string. Measured live: a 45-char
  // headline ("All the warmth of a puffer without the puff") shipped as
  // "All the warmth of a puffer…" on `pmax_video_16_9` (cap 32) and "All the
  // warmth of a puffer without the…" on `meta_reels_9_16`'s hook phase (cap
  // 40) — same defect class as the funnel-stage duplication above, just
  // triggered by width instead of by stage, so it is fixed at the same call:
  // whenever the cascade's headline does not fit THIS ad's actual cap, look
  // for a candidate that does (any concept, any stage-preferred order) via
  // the SAME videoHeadlineService "select, never truncate" contract (owner
  // directive: "Let the director make the call, it has a lot to choose
  // from") — and only if nothing fits does the plain word-safe clamp remain
  // the true last resort, exactly mirroring fitProductNameToCap's own
  // fallback rule.
  //
  // Read-only and best-effort by construction: videoHeadlineService never
  // calls the Director LLM, so this cannot bill. It only overrides when a
  // strictly-better candidate actually resolves — no candidates (or nothing
  // fits better) means the cascade's own answer stands unchanged, never a
  // template and never an empty slot. Inert when the cascade headline is
  // null/empty (nothing to fit-check) or already fits.
  if (cascaded && typeof cascaded.headline === 'string' && cascaded.headline.trim()) {
    try {
      const { resolveVideoHeadlineCandidates, selectVideoHeadline } = require('./videoHeadlineService');
      const { deriveCharCap, CANVAS_WIDTH_DEFAULT } = require('../remotion/lib/slotContent.js');
      const headlineFormat = classifyFormat(ad);
      const realCap = deriveCharCap('headline', {
        format: headlineFormat,
        platformFormat: ad.platformFormat || null,
        canvasWidth: CANVAS_WIDTH_DEFAULT[headlineFormat] || null,
      });
      const currentFits = !Number.isFinite(realCap)
        || cascaded.headline.replace(/\s+/g, ' ').trim().length <= realCap;

      if (ad?.funnelStage || !currentFits) {
        const candidates = await resolveVideoHeadlineCandidates({
          brandId:      brand?._id || ad.brandId || null,
          productId:    ad.productId || null,
          campaignKind: ad.campaignKind || null,
          funnelStage:  ad.funnelStage || null,
        });
        // Prefer a candidate that FITS THE REAL CAP over videoHeadlineService's
        // own coarser per-canvas-format budget (HEADLINE_CHAR_BUDGET) — that
        // table predates per-platformFormat/safe-zone caps and is only an
        // estimate for `vertical` (see its own header comment); deriveCharCap
        // is what the renderer actually enforces.
        const staged = Number.isFinite(realCap)
          ? selectVideoHeadline({ candidates, budgetChars: realCap })
          : selectVideoHeadline({ candidates, format: headlineFormat });
        if (typeof staged === 'string' && staged.trim() && staged !== cascaded.headline) {
          console.log(
            `   🎯 funnelCopy[ad=${ad._id}] stage=${ad.funnelStage || 'none'} cap=${realCap ?? 'n/a'}: ` +
            `headline differentiated ("${String(cascaded.headline || '').slice(0, 28)}" → "${staged.slice(0, 28)}")`
          );
          cascaded.headline = staged;
        }
      }
    } catch (err) {
      // Differentiation/fit-check is an enhancement, not a render gate — the
      // video is already billed by the time titling runs.
      console.warn(`   ⚠️  funnelCopy[ad=${ad?._id}]: stage/fit headline check failed (${err.message}) — keeping cascade headline`);
    }
  }

  // Derived fields — not cascadeable because they depend on other
  // resolved meta or on ad-level state that isn't a data source.
  // endcardMode routes the canonical scripts' brand vs product endcard
  // branch. reviewsText is a formatted string built from reviewCount.
  const endcardMode = ad.productId ? 'product' : 'brand';

  // ── Tier-coherent social proof (services/ratingDisplay.js) ──────────
  // resolveCoherentSocialProof is the ONE place quote-tier <-> number-tier
  // pairing is decided (committed, 48 revert-proven checks in
  // scripts/verifyCoherentSocialProof.js). This replaces the ad hoc guard
  // that used to live here (allowBrandCountWithoutStars / renderedQuote ===
  // brandQuoteText): that guard only ever protected the BRAND-count-without-
  // stars outcome and could not see a product-tier or category-tier quote
  // mixing with the wrong number tier at all (R1).
  const {
    resolveCoherentSocialProof, brandAttributionLabel,
  } = require('./ratingDisplay');

  // Already provenance-gated above (gateLayoutInputQuotes / toPrintable
  // CustomerQuote) — the chokepoint expects an already-gated quote and does
  // not re-gate provenance itself.
  const pq = layoutInput?.input?.social_proof?.primary_quote;

  // ── renderedQuoteText: the line the 'quote' SLOT will ACTUALLY typeset ──
  // quotePrintsOnFrame (ratingDisplay.js) has NO default — omit this and the
  // chokepoint withholds every number. The naive guess `meta.quoteSnippet ||
  // meta.quote` is WRONG: the live binding is a per-slot BIND LIST
  // (titleSpecValidator.DEFAULT_BIND.quote = ['quoteSnippet','quote']),
  // itself resolved per format via titleSpecService.resolveSpec's tier
  // ladder (explicit presetOverride -> persisted titleStyleSpec ->
  // brand.titleStylePreset -> intentPreset -> canonical), and the bind list is overridable
  // per slot.
  // renderWithRemotionAndSave calls resolveSpec with these SAME inputs
  // moments after this function returns — reproduce that resolution here
  // (not a hardcoded guess) so the compared string is what will really
  // render. Run it through the real renderer resolver
  // (remotion/lib/slotContent.js resolveSlotContentCore, same module
  // scripts/verifyTitleSpecResolution.js already requires from a CJS
  // harness) so the 120-char word-safe cap the composition applies is
  // honoured too — an untruncated compare would authorise numbers beside a
  // quote that actually renders shorter than what was checked.
  //
  // F4 (fixed here): the old guard compared `cascaded.quote` ALONE, but the
  // renderer's default bind checks `quoteSnippet` FIRST — a
  // Brand.metaCascades.quoteSnippet override could substitute a different
  // line the old guard never looked at.
  let renderedQuoteText = null;
  if (pq && String(pq.text || '').trim()) {
    try {
      const { resolveSpec } = require('./titleSpecService');
      const { resolveSlotContentCore } = require('../remotion/lib/slotContent.js');
      const format = classifyFormat(ad);
      let categoriesForSpec = [];
      if (catalogProduct) {
        try {
          const { loadCategoryChainForProduct } = require('./categoryChainService');
          categoriesForSpec = await loadCategoryChainForProduct(catalogProduct);
        } catch { /* spec still resolves via the preset/canonical tiers */ }
      }
      // SAME spec the render path will use. Explicit presetOverride
      // (CLI --preset=) is TIER 0; funnel stage is intentPreset (TIER 2.5
      // floor), never a whole-spec replace. When omitted we re-derive the
      // intent floor from ad.funnelStage so a solo buildMetaForAd call
      // still matches renderWithRemotionAndSave.
      const presetOverride = opts.presetOverride != null && String(opts.presetOverride).trim() !== ''
        ? String(opts.presetOverride).trim()
        : null;
      let intentPreset = opts.intentPreset;
      if (intentPreset === undefined) {
        try {
          const { resolveFunnelPresetOverride } = require('./campaignAdsGenerationService');
          intentPreset = resolveFunnelPresetOverride(ad);
        } catch {
          intentPreset = null;
        }
      }
      if (presetOverride) intentPreset = null;
      const { spec: resolvedTitleSpec } = resolveSpec({
        brand, product: catalogProduct, ad, format, categories: categoriesForSpec,
        presetOverride, intentPreset,
      });
      const quoteSlot = resolvedTitleSpec?.slots?.find((s) => s.key === 'quote') || null;
      if (quoteSlot) {
        // Only the fields the quote slot's bind chain can read — the
        // pre-decision cascade values (BEFORE the chokepoint's own
        // quote/quoteSnippet overwrite below), since we're checking what
        // WOULD render absent that overwrite.
        const candidateMeta = {
          quote:        cascaded.quote        ?? null,
          quoteSnippet: cascaded.quoteSnippet ?? null,
          endcardMode,
        };
        const resolvedValue = resolveSlotContentCore(quoteSlot, candidateMeta);
        renderedQuoteText = typeof resolvedValue === 'string' && resolvedValue ? resolvedValue : null;
      }
    } catch (err) {
      // Never throw on a billed render path. An unresolved bind means we
      // cannot prove what renders, so numbers get withheld (fail-closed) —
      // the same outcome as an explicit mismatch, not a crash.
      console.warn(`🔒 buildMetaForAd[ad=${ad._id}]: quote-slot bind resolution failed (${err.message}) — renderedQuoteText withheld, numbers gated closed`);
      renderedQuoteText = null;
      // Surface it PER-AD, not just in a worker log. Failing closed is right —
      // an unverifiable quote must not carry a review count — but the visible
      // consequence is an ad that silently ships with no stars and no count,
      // which looks identical to a brand that simply has no review data. Without
      // this the operator has no way to tell "we withheld proof because we could
      // not prove which line renders" from "this brand has no proof". Same
      // reasoning as the generation-size mismatch issue on the static path: a
      // console warning on a worker nobody is tailing is not an alarm.
      try {
        const { noteRenderIssue } = require('./adStage');
        noteRenderIssue(ad._id, {
          message: `social proof withheld — could not resolve which quote line renders (${err.message})`,
          stage: 'social-proof-gate'
        });
      } catch { /* telemetry is fire-and-forget; never let it break a render */ }
    }
  }

  // ── Product snapshot: ONE document, never two independently-cascaded
  // scalars (the R2 hole: metaCascadeConfig.js resolves `rating` and
  // `reviewCount` as two INDEPENDENT cascades, so a rating from one
  // snapshot could pair with a count from another). Prefer CatalogProduct
  // when it carries EITHER field; else layoutInput.social_proof AS A PAIR —
  // but only when that artifact's own pair is verified atomic
  // (`rating_source === 'product'`, stamped by
  // layoutInputService.deriveSocialProofNumbers). A stale artifact (written
  // before that fix — ~722/738 in production — carries NO `rating_source`
  // at all, so its pair is NOT trusted as product numbers here;
  // CatalogProduct becomes the sole product-tier source for those ads
  // instead (or no product pair, if CatalogProduct also has nothing). This
  // does not drop brand-legitimate proof: the BRAND snapshot below is
  // Brand.brandReviews, fetched independently and unaffected by any of this.
  // TIER ORDER within CatalogProduct, and why `productReviews` comes FIRST:
  // it is the only container either review writer fills, both numbers are
  // written together in one update, and it is the fresher of the two. Top-level
  // `rating` is a MIRROR that only catalogProductReviewRefreshService writes
  // (:108) — the automatic Gemini gap-fill never touches it — and its original
  // writer was an Immersive product_results import, so it can be stale while
  // `productReviews` is current. It also cannot carry a count at all (no such
  // schema path), so it is a rating-only last resort, kept because a product
  // whose only data is that mirror should still show its stars.
  //
  // Both branches still satisfy the R2 rule this block exists for — ONE
  // document, never two independently-cascaded scalars.
  const PRODUCT_PROOF_FROM_REVIEWS =
    String(process.env.PRODUCT_PROOF_FROM_REVIEWS ?? 'true').toLowerCase() !== 'false';
  const pr = PRODUCT_PROOF_FROM_REVIEWS && catalogProduct && typeof catalogProduct.productReviews === 'object'
    ? catalogProduct.productReviews : null;
  // Must carry a USABLE RATING to win, not merely a count. Winning on count
  // alone would produce `{rating: null, reviewCount: N}` and erase a good
  // top-level `rating` — a proof regression. Requiring the rating also keeps the
  // pair atomic (both numbers from one document), which is the R2 rule above.
  // Nothing is lost: a count never renders without a rating beside it.
  const prHasRating = !!pr && typeof pr.rating === 'number';
  const catalogHasRatingOrCount = !!catalogProduct && typeof catalogProduct.rating === 'number';
  let productSnapshot = null;
  if (prHasRating) {
    productSnapshot = { rating: pr.rating, reviewCount: pr.reviewCount ?? null };
  } else if (catalogHasRatingOrCount) {
    productSnapshot = { rating: catalogProduct.rating ?? null, reviewCount: null };
  } else {
    const liSocialProof = layoutInput?.input?.social_proof;
    if (liSocialProof && liSocialProof.rating_source === 'product'
        && (typeof liSocialProof.rating_value === 'number' || typeof liSocialProof.review_count === 'number')) {
      productSnapshot = { rating: liSocialProof.rating_value ?? null, reviewCount: liSocialProof.review_count ?? null };
    }
  }

  // ── Brand snapshot: Brand.brandReviews, ONE document (rating + count
  // written together by enrichment) — never averaged from CatalogProduct
  // rows, never the layoutInput brand-fallback pair (that exists only so a
  // no-SKU ad isn't blank; the video path always has this real snapshot).
  const brandSnapshot = brand?.brandReviews && typeof brand.brandReviews === 'object'
    ? { rating: brand.brandReviews.rating ?? null, reviewCount: brand.brandReviews.reviewCount ?? null }
    : null;
  const brandAttribution = brandAttributionLabel(brand);

  const coherent = resolveCoherentSocialProof({
    quote: pq || null,
    product: productSnapshot,
    brand: brandSnapshot,
    brandAttribution,
    renderedQuoteText,
  });

  // Log the decision: a product-tier rating beside a brand-tier quote (or
  // vice versa) can no longer happen post-chokepoint, but source/tier
  // pairing is worth seeing in Render logs for diagnosability.
  console.log(
    `coherentProof[ad=${ad._id}]: source=${coherent.source || 'none'} rating=${coherent.rating || 'none'} ` +
    `count=${coherent.reviewCount ?? 'none'} quoteTier=${coherent.quoteTier || 'none'}`
  );
  const rating = coherent.rating;
  const reviewCount = coherent.reviewCount;
  const reviewsText = coherent.reviewsText;

  // F4 IMPOSSIBLE BY CONSTRUCTION: once the chokepoint has decided which
  // quote (if any) is coherent with these numbers, THAT is the quote that
  // ships. A tenant cascade override (Brand.metaCascades.quote /
  // quoteSnippet) cannot substitute a different line after the fact — when
  // the chokepoint's decision carries a non-null quote, it OVERWRITES both
  // quote fields; only when it carries none (no gated quote existed at all)
  // do the ordinary cascaded values stand. Deliberately fail-closed: a
  // tenant override for proof copy losing to the gated line is a smaller
  // cost than an unsubstantiated number beside a testimonial.
  const finalQuoteText = coherent.quote ? (coherent.quote.text || null) : (cascaded.quote ?? null);
  const finalQuoteSnippet = coherent.quote ? (coherent.quote.snippet ?? null) : (cascaded.quoteSnippet ?? null);

  // deliveryLine and promoText share their two highest-priority sources
  // (ad.copy.offer_text, then layoutInput.input.cta.offer_text), so any ad
  // with an offer set resolves both to the SAME string and paints it twice —
  // e.g. "Only $28" as both the delivery line and the promo pill. promoText
  // is the one designed to be skippable (its cascade deliberately has no
  // literal fallback), so it yields when it would only repeat the line above.
  const promoText = cascaded.promoText && cascaded.promoText === cascaded.deliveryLine
    ? null
    : (cascaded.promoText ?? null);

  // Display-clean productName (strip trailing parentheticals, leading
  // gender qualifier, redundant own-brand token); keep full raw cascade
  // value as productNameFull so nothing loses data. brandName passed so the
  // redundant-brand-token strip only ever matches THIS ad's own brand.
  const productNameCleaned = cleanProductNameForDisplay(cascaded.productName ?? null, cascaded.brandName ?? null);

  // ── Claim substantiation gate ─────────────────────────────────────────
  // badgeText / badges / deliveryLine are the one part of `cascaded` that
  // is NOT run through resolveCoherentSocialProof above, even though they
  // can carry the exact same class of claim the coherence chokepoint exists
  // to police: badgeText and badges both cascade from `input.product.badges`
  // (services/metaCascadeConfig.js), which services/layoutInputService.js
  // populates from an ungated Gemini derivation call — confirmed live to
  // invent "Top rated" / "Best seller" / "Sustainably made" on an ad whose
  // real rating/reviewCount were both null (run_1787174963435_ff67021e).
  // deliveryLine reads `input.product.badges[1]` today (PR #261, open,
  // retargets it to an empty cascade — this gate is a no-op once that lands,
  // since gating `null`/`undefined` is already a pass-through).
  //
  // Gate AFTER the coherence chokepoint, using the SAME `rating`/
  // `reviewCount` pair it just resolved (never the LLM's own stated
  // number) — a "Top rated" badge can only survive on an ad whose own
  // printed star line already earned it. See
  // services/claimSubstantiationService.js for the full doctrine
  // (barred-outright categories vs evidence-gated categories) and
  // scripts/verifyClaimSubstantiation.js for the revert-proof pins.
  const { substantiateBadge, substantiateBadges } = require('./claimSubstantiationService');
  const claimEvidence = { rating, reviewCount };
  const gatedBadgeText = substantiateBadge(cascaded.badgeText ?? null, claimEvidence);
  const gatedBadges = substantiateBadges(cascaded.badges, claimEvidence);
  const gatedDeliveryLine = substantiateBadge(cascaded.deliveryLine ?? null, claimEvidence);

  return {
    // Cascaded fields — every one of these can be re-pointed via
    // Brand.metaCascades[<field>] without a code change. Undefined
    // entries (no source produced a value) fall through as `null`
    // to preserve the shape callers expect.
    brandName:          cascaded.brandName          ?? null,
    // badgeText / badges / deliveryLine: substantiation-gated, not the raw
    // cascade value — see "Claim substantiation gate" above.
    badgeText:          gatedBadgeText,
    productName:        productNameCleaned.productName,
    productNameFull:    productNameCleaned.productNameFull,
    productDescription: cascaded.productDescription ?? null,
    price:              cascaded.price              ?? null,
    benefits:           cascaded.benefits           ?? [],
    badges:             gatedBadges,
    headline:           cascaded.headline           ?? null,
    // quote / quoteSnippet: forced to the chokepoint's verified line when
    // one exists — see the "F4 IMPOSSIBLE BY CONSTRUCTION" comment above.
    quote:              finalQuoteText,
    // Bare initials ("D") are not attribution — see usableAttribution.
    reviewer:           usableAttribution(cascaded.reviewer) ?? null,
    deliveryLine:       gatedDeliveryLine,
    ctaText:            cascaded.ctaText            ?? null,
    cta:                cascaded.ctaText            ?? null,   // legacy alias for older scripts reading meta.cta
    rating,
    // Count from the SAME tier as rating (coherent pair). Null when the
    // chosen tier has no count — never a cross-tier mix.
    reviewCount,
    likes:              cascaded.likes              ?? null,
    quoteSnippet:       finalQuoteSnippet,
    promoText,   // null lets the renderer skip the promo pill (see dedupe above)
    productOnlyImageUrl: cascaded.productOnlyImageUrl ?? null,

    // Alias for the Remotion titling engine's `productImage` slot bind
    // chain. Same value as productOnlyImageUrl; the remotion render
    // service downloads it to the per-job asset server and overwrites
    // in place (same pattern as brandLogoUrl).
    productImageUrl:    cascaded.productOnlyImageUrl ?? null,

    // Brand-level pass-throughs (also cascadeable — brands can point
    // these at LI-derived fields via Brand.metaCascades).
    brandLogoUrl:       cascaded.brandLogoUrl    ?? null,
    brandTagline:       cascaded.brandTagline    ?? null,
    brandWebsiteUrl:    cascaded.brandWebsiteUrl ?? null,

    // Derived / non-cascadeable fields.
    endcardMode,
    reviewsText,

    // ── Theme (canonical path) ─────────────────────────────────────
    // Derived from three sources in priority order (higher wins):
    //   1. Brand.styleTheme (operator-curated canonical script keys)
    //   2. Brand.primaryColor / accentColor / secondaryColor / fontFamily
    //   3. LayoutInputArtifact.input.brand.* (LLM-derived per-artifact)
    // Not part of the cascade engine — theme is a color/font blob,
    // not a text-value ladder. Kept as its own resolver.
    theme:              deriveTheme(brand, layoutInput?.input || null),
  };
}

// Merge theme signals from Brand.styleTheme, Brand.* color/font fields,
// and LayoutInputArtifact.input.brand into the shape the canonical
// scripts consume. Brand.styleTheme keys always win when explicitly
// set — this preserves operator-curated overrides. The rest of the
// slots fall back through Brand.primaryColor → layoutInput.brand →
// canonical defaults.
function deriveTheme(brand, li) {
  const explicit = brand?.styleTheme || {};

  const brandColors = {
    primary:   hexToRgbArray(brand?.primaryColor   || li?.brand?.primary_color),
    secondary: hexToRgbArray(brand?.secondaryColor || li?.brand?.secondary_color),
    accent:    hexToRgbArray(brand?.accentColor    || li?.brand?.accent_color)
  };

  const brandFont = brand?.fontFamily || li?.brand?.font_family || null;

  // Only fill slots that aren't already set on styleTheme. Undefined
  // means "let the canonical script's default apply" — cleaner than
  // writing null and forcing the script to null-check.
  return {
    // Text
    textPrimary:      explicit.textPrimary      || [255, 255, 255],
    textSecondary:    explicit.textSecondary    || brandColors.secondary || [220, 220, 220],
    // Backdrops / scrims
    scrimColor:       explicit.scrimColor       || [0, 0, 0],
    endcardBgColor:   explicit.endcardBgColor   || brandColors.primary || [8, 8, 10],
    // Accents (promo pill, badge). Tracks brand accent color when
    // available so the pill matches brand identity.
    accentColor:      explicit.accentColor      || brandColors.accent || brandColors.primary,
    promoBgColor:     explicit.promoBgColor     || brandColors.accent || [245, 183, 10],
    // Stars are a universal ecommerce convention (warm gold ★★★★★).
    // Do NOT fall through to brandColors.accent — brands with dark
    // accents (navy / deep grey) end up with invisible stars against
    // the dark endcard background wash. Only respect an explicit
    // styleTheme.starColor override.
    starColor:        explicit.starColor        || [245, 183, 10],
    promoTextColor:   explicit.promoTextColor   || [22, 22, 26],
    // Fonts — brandFont applies to headings + body; quote defaults serif.
    headingFontFamily: explicit.headingFontFamily || brandFont || 'PlayfairDisplay',
    bodyFontFamily:    explicit.bodyFontFamily    || brandFont || 'Inter',
    quoteFontFamily:   explicit.quoteFontFamily   || 'Lora',
    // Pass-through: any other keys operators added to styleTheme.
    ...explicit
  };
}

// Convert a "#RRGGBB" or "#RGB" hex string into [r, g, b] for the
// canonical scripts' rgba() helper. Returns null on empty / invalid
// input so the caller can fall through to the next source.
function hexToRgbArray(hex) {
  if (!hex) return null;
  const clean = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(clean)) return null;
  const s = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return [r, g, b];
}

// Resolve which script source to run for one ad. Format-aware — the
// ad's platformFormat determines which brand slot and which canonical
// variant apply. Per-format priority ladder:
//
//   vertical (9:16):   brand.styleScriptVertical  → canonical vertical
//   landscape (16:9):  brand.styleScriptLandscape → canonical landscape
//   feed (4:5, 1:1):   brand.styleScript          → canonical feed
//
// Canonical is now the DEFAULT — no opt-in gate. meta.theme is derived
// in buildMetaForAd from Brand.styleTheme, Brand.* color fields, and
// LayoutInputArtifact.input.brand, with sensible defaults filling every
// missing slot. So every canonical run has enough to render, and
// operator-curated styleTheme still wins when it exists.
async function resolveBrandRenderer(brand, ad) {
  const format     = classifyFormat(ad);
  const brandField = BRAND_SCRIPT_FIELD[format];

  // 1. Custom per-format brand script (operator override)
  const brandScript = brand?.[brandField];
  if (brandScript && String(brandScript).trim()) {
    return { path: 'custom', script: brandScript, format };
  }
  // 2. Canonical for this format — always fires when no custom script.
  const {
    getCanonicalScript,
    getCanonicalScriptVertical,
    getCanonicalScriptLandscape
  } = require('./systemConfigService');
  const getter = {
    vertical:  getCanonicalScriptVertical,
    landscape: getCanonicalScriptLandscape,
    feed:      getCanonicalScript
  }[format];
  if (!getter) return { path: 'canonical', script: null, canonicalSource: null, format };
  const got = await getter();
  return {
    path: 'canonical',
    script: got?.script || null,
    canonicalSource: got?.source || null,
    format
  };
}

// Which title compositor renders this ad. Force-locked to Remotion —
// the canvas engine is disabled while the Video Script card is hidden
// on the operator UI. Existing Brand.styleScript* documents remain in
// the DB (data preserved), just ignored at render time. Same for
// Brand.videoSettings.titlingEngine='canvas' and TITLING_ENGINE=canvas.
// To re-enable canvas: remove the short-circuit below, revert the
// commented block, and unhide the StyleOverridesCard in Brand/index.tsx.
function resolveTitlingEngine(brand, ad) {
  const format = classifyFormat(ad);
  // Kill-switch: always Remotion. Log once per render so the choice is
  // visible in the ad's render log, and callers can see WHY when they
  // wonder why a custom styleScript isn't taking effect.
  const custom = brand?.[BRAND_SCRIPT_FIELD[format]];
  if (custom && String(custom).trim()) {
    console.log(`🎨 resolveTitlingEngine[ad=${ad?._id || '?'}]: brand has a custom ${BRAND_SCRIPT_FIELD[format]} but canvas engine is disabled — falling through to remotion`);
  }
  return { engine: 'remotion', source: 'canvas-disabled', format };

  /* Original cascade — restore when re-enabling the canvas path:
  const customScript = brand?.[BRAND_SCRIPT_FIELD[format]];
  if (customScript && String(customScript).trim()) {
    return { engine: 'canvas', source: 'custom-script', format };
  }
  const links = [
    ['Brand.videoSettings.titlingEngine', brand?.videoSettings?.titlingEngine],
    ['TITLING_ENGINE env', process.env.TITLING_ENGINE],
  ];
  for (const [source, val] of links) {
    if (!val) continue;
    if (val === 'canvas' || val === 'remotion') return { engine: val, source, format };
    console.warn(`⚠️  resolveTitlingEngine: unknown engine '${val}' from ${source} — falling through`);
  }
  return { engine: 'remotion', source: 'default', format };
  */
}

// ── Post-render VIDEO vision QC ───────────────────────────────────────
// Closes the gap where the video pipeline shipped with ZERO vision
// inspection while statics were protected (services/adVisionQcService.js
// file-header CONTRACT block has the full static-vs-video comparison).
//
// Single choke point: called from uploadRenderAndStamp, the tail BOTH
// titling engines (remotion + canvas) funnel through — so every video ad
// gets exactly one inspection of its ACTUAL delivered pixels (post-crop,
// post-titling), regardless of engine, without touching routes/ads.js
// (heavily contended right now — #227 rebasing, the undispatched-tail fix
// in progress).
//
// Wrapped in try/catch with NOTHING allowed to escape: uploadRenderAndStamp
// is the single place EVERY video ad's renderUrl gets written, so an
// uncaught exception here would break video rendering repo-wide, not just
// QC. Any internal failure degrades to returning null (treated exactly
// like "QC disabled" by the caller — Ad.visionQc stays unstamped) rather
// than propagating.
//
// Returns a persisted-verdict object (buildPersistedVerdict shape) to merge
// into Ad.visionQc — including when the flag is off. FIXED 2026-08-19: this
// used to `return null` on `!isEnabled()`, on the stated theory that
// mirroring directImageRenderService's (then-identical) early return made
// "never inspected" read the same way (an absent field) across both
// pipelines. In production that symmetry was the bug: a live 39-ad run
// shipped with Ad.visionQc:null on every ad (static AND video) because
// SystemConfig.videoVisionQcEnabled was unset/false and no override existed —
// and an absent field is EXACTLY what "inspected and passed" also looks
// like everywhere downstream (summarizeVisionQc, GET /runs/:runId
// shippedWithoutQc, this file's own gallery badge). Both early returns now
// build the same disabled-verdict shape runVideoPostRenderQc's/
// runPostRenderQc's own "Flag off" branch constructs, so "never inspected"
// is a real stamped fact, not an absence indistinguishable from "clean".
async function runVideoVisionQcForAd({ ad, deliveredUrl, brandName = null }) {
  try {
    const adVisionQc = require('./adVisionQcService');
    // AWAIT the real gate — see the matching comment in
    // directImageRenderService.js. This function is already `async` and
    // already awaits runVideoPostRenderQc a few lines below, so there is no
    // reason to read the racy sync isEnabled() cache peek: a call landing
    // just past the 5s TTL (the normal case — real renders are spaced much
    // further apart than that) would read a cache miss as "off" even when
    // SystemConfig.adVisionQcEnabled is genuinely true.
    // VIDEO pipeline — reads the video-specific gate: resolveVideoEnabled()
    // (2026-08-21 split; was the single resolveEnabled() gate before then).
    // This is the ONE gate check for this file — every caller of this
    // function relies on it rather than checking the gate itself, so there
    // is no second call site here to update.
    const qcEnabledNow = await adVisionQc.resolveVideoEnabled();
    if (!qcEnabledNow) {
      adVisionQc.warnQcDisabledOnce('video ad');
      return adVisionQc.buildPersistedVerdict({
        passed: false, skipped: true, disabled: true,
        reason: 'vision QC disabled (SystemConfig.videoVisionQcEnabled)', finalAttempt: null, attempts: []
      });
    }

    const videoFrameService = require('./videoFrameService');
    const { adStage, noteRenderIssue } = require('./adStage');

    // ORIGINAL product photos — the EXACT reference stack actually sent to
    // the video model (veoReferenceImages[]; models/Ad.js: "pos 0 = seed",
    // 1..N = additional refs) so the vision judge scores frames against
    // the same visual ground truth the video model had. The pre-2026-09-02
    // behaviour was to pass ONLY veoReferenceImages[0] — which flagged
    // every legitimate colorway change (reversible swimsuits, multi-print
    // shirts photographed on-model + packshot) as product_fidelity drift,
    // and every legitimate branding element that lived on a back panel /
    // hang tag visible only in an ALT reference as invented competitor
    // mark. Passing the whole array as originalProductUrls lets the judge
    // treat the union as ground truth (see buildVideoVisionUserContent).
    //
    // Derive-only ads (cropped from a sibling master, models/Ad.js
    // `deriveFromMaster`) never populate their own veoReferenceImages
    // — a derive is retitled from the master's already-paid clip and
    // never submits to Omni itself — so fall back to the catalog hero.
    // A catalog fallback of ONE image reproduces the pre-2026-09-02 M=1
    // behaviour for these ads exactly, so this is not a regression on
    // the derive path.
    let originalProductUrls = (Array.isArray(ad.veoReferenceImages) && ad.veoReferenceImages.length)
      ? ad.veoReferenceImages.filter((u) => typeof u === 'string' && u.trim())
      : [];
    if (!originalProductUrls.length && ad.productId) {
      try {
        const CatalogProduct = require('../models/CatalogProduct');
        const prod = await CatalogProduct.findById(ad.productId).select('imageUrl').lean();
        if (prod?.imageUrl) originalProductUrls = [prod.imageUrl];
      } catch { /* falls through to the skipped verdict below */ }
    }

    let resolvedBrandName = brandName;
    if (!resolvedBrandName && ad.brandId) {
      try {
        const Brand = require('../models/Brand');
        const b = await Brand.findById(ad.brandId).select('name').lean();
        resolvedBrandName = b?.name || null;
      } catch { /* non-fatal — QC still runs, just with a generic brand label */ }
    }

    // durationSec: SAME helper basePlateCropService.js uses for detectClipBoxes
    // (videoDurationPolicy.resolveAdVideoDurationSec) — do not re-derive with
    // a second convention (e.g. ffprobe).
    const { resolveAdVideoDurationSec } = require('./videoDurationPolicy');
    const durationSec = resolveAdVideoDurationSec(ad);
    // Quartile sampling ALONE (25/50/75%, videoFrameService.planTimestamps)
    // is a good evidence set for a PERSISTENT defect — verified 2026-08-19
    // against a real delivered ad (run run_1787136860887_654ed621, Vuori
    // Bone Denim jacket rendered as light blue denim with a garbled "VOME"
    // woven neck label): visible at EVERY quartile, confirming that class
    // of hallucination persists across the whole clip rather than being a
    // one-frame glitch.
    //
    // It is BLIND to a TRANSIENT one. PROVEN 2026-08-20: a hallucinated
    // storefront-UI overlay (nav bar, shopping-bag icon, garbled
    // header/footer text) baked into a video plate was visible at
    // t=0.1s/0.5s and completely gone by t=2.5s — on a ~10s clip, quartile
    // sampling hits 2.5/5.0/7.5s and would see NOTHING.
    //
    // videoQcFrameSelectionService closes that gap with a cheap, NON-
    // billable pre-filter in front of the paid vision call: it probes a
    // dense, early-weighted set of tiny frames (Cloudinary edge transform —
    // no vision cost), scores each against the clip's own steady state,
    // and sends the vision model the quartile baseline above PLUS up to 2
    // frames that actually look like outliers (capped at 5 total). A clean
    // clip — the common case — still costs exactly the same 3 frames as
    // before; see that module's file header for the full design and the
    // measured cost delta. Kill switch VIDEO_QC_DENSE_SAMPLING (default
    // true) restores this exact quartile-only call with no deploy.
    const frameSelectionService = require('./videoQcFrameSelectionService');
    const frameSelection = await frameSelectionService.selectQcFrameTimestamps({
      deliveredUrl, durationSec
    });
    const frames = videoFrameService.buildFrameUrlsAtTimestamps(deliveredUrl, frameSelection.timestamps);
    if (frameSelection.flaggedCount > 0) {
      console.log(
        `   🔎 brandScript[ad=${ad._id}]: vision QC (video) dense pre-filter flagged ` +
        `${frameSelection.flaggedCount} extra frame(s) of ${frameSelection.denseCount} probed`
      );
    }

    const campaignRunId = (Array.isArray(ad.campaignRunIds) && ad.campaignRunIds.length)
      ? ad.campaignRunIds[ad.campaignRunIds.length - 1]
      : null;
    const appUrl = adVisionQc.buildAppPreviewUrl({
      campaignRunId, campaignId: ad.campaignId || null, brandId: ad.brandId || null
    });

    adStage(ad._id, 'vision QC (video)');
    const qcResult = await adVisionQc.runVideoPostRenderQc({
      enabled: true,
      originalProductUrls,
      frames,
      brandName: resolvedBrandName,
      brandId: ad.brandId || null,
      productId: ad.productId || null,
      adId: ad._id || null,
      deliveredUrl
    });

    if (qcResult.skipped || qcResult.uninspected) {
      const reason = qcResult.visionQc?.reason || 'vision QC did not inspect this render';
      console.warn(`   ⚠️  brandScript[ad=${ad._id}]: vision QC (video) skipped — ${reason}`);
      noteRenderIssue(ad._id, { message: `vision QC (video) skipped: ${reason}`, stage: 'vision-qc' });
      adVisionQc.alertQcSkipped({
        adId: ad._id, brandId: ad.brandId, productId: ad.productId,
        brandName: resolvedBrandName, reason, mediaLabel: 'Video ad'
      });
      return qcResult.visionQc;
    }

    if (!qcResult.passed) {
      // FLAG, DON'T DISCARD, AND (owner decision 2026-08-20) DON'T SHIP AS A
      // NORMAL DRAFT EITHER — see adVisionQcService.runVideoPostRenderQc's
      // docstring for the money reasoning behind never regenerating/
      // discarding. uploadRenderAndStamp (below, this file) reads
      // qcResult.visionQc.passed off the object we return here and flips
      // Ad.status to 'failed' while keeping the already-paid renderUrl.
      //
      // alertQcFailure returns the EXACT text it just sent to Slack — stamp
      // it onto the SAME qcResult.visionQc object that ships on Ad.visionQc,
      // so the detail screen and Slack are provably reading one string.
      const failureDetail = adVisionQc.alertQcFailure({
        adId: ad._id, brandId: ad.brandId, productId: ad.productId,
        brandName: resolvedBrandName, visionQc: qcResult.visionQc, appUrl,
        regenerated: false, mediaLabel: 'Video ad'
      });
      if (failureDetail) qcResult.visionQc.failureDetail = failureDetail;
      adVisionQc.noteQcFailToRunFeed({
        campaignRunId, adId: ad._id, aspectRatio: ad.aspectRatio, platformFormat: ad.platformFormat,
        visionQc: qcResult.visionQc, previewUrl: deliveredUrl, appUrl
      });
      console.warn(
        `   ⚠️  brandScript[ad=${ad._id}]: vision QC (video) FAILED — flagged on Ad.visionQc, ` +
        'delivering as failed (master already paid for; asset kept, see PR description)'
      );
    } else {
      adVisionQc.noteQcPassToRunFeed({
        campaignRunId, adId: ad._id, aspectRatio: ad.aspectRatio, platformFormat: ad.platformFormat,
        visionQc: qcResult.visionQc, previewUrl: deliveredUrl, appUrl
      });
      console.log(`   ✅ brandScript[ad=${ad._id}]: vision QC (video) pass`);
    }
    return qcResult.visionQc;
  } catch (err) {
    // MUST NEVER throw into uploadRenderAndStamp — see file comment above.
    //
    // FIXED 2026-08-20 — this used to `return null`, which the caller reads
    // as "nothing to stamp" (see the `if (videoVisionQc)` guard at both call
    // sites), leaving Ad.visionQc untouched. That is the EXACT visibility
    // gap this whole file's disabled-gate fix (2026-08-19) closed for the
    // "QC is off" case, reopened for "QC threw" instead: an infra failure
    // (frame-URL build, a Brand/CatalogProduct lookup, the vision call
    // itself) is indistinguishable from "not yet processed" or, worse, from
    // "inspected and passed" — the exact absence-read-as-clean bug this
    // service exists to prevent. Build the same kind of real, queryable
    // stub `runPostRenderQc`'s own throw-handling branch does for statics
    // (adVisionQcService.runPostRenderQc's `catch` around `judge(...)`),
    // instead of silently shipping unstamped.
    const msg = (err && err.message) ? err.message : String(err || 'unknown');
    console.warn(
      `   ⚠️  brandScript[ad=${ad && ad._id}]: vision QC (video) infra error — shipping with a skipped stub: ${msg}`
    );
    try {
      const adVisionQc = require('./adVisionQcService');
      return adVisionQc.buildSkippedVerdict(`vision QC (video) infra error: ${msg}`);
    } catch {
      // adVisionQcService itself would not even load — truly nothing left
      // to stamp with. Extremely unlikely (the same require succeeded a few
      // lines up in the try) but this function must still never throw.
      return null;
    }
  }
}

// Owner decision 2026-08-20: a REAL video QC failure (not skipped/disabled —
// same tri-state check imageRecoveryService.js's qcFailed uses) now delivers
// the ad as status:'failed' with a short renderError, instead of the normal
// draft it used to fall through to. NEVER discards the asset — the caller
// still writes renderUrl/posterUrl/visionQc; this only adds the two fields
// below on top when the verdict is a real fail. Shared by BOTH places a
// video ad's terminal status gets stamped (uploadRenderAndStamp for a
// titled render, and renderBrandScriptAndSave's no-chrome branch for a
// format with nothing to title) so the two paths cannot drift on what
// "failed vision QC" means.
function buildVideoQcFailureFields(videoVisionQc) {
  const qcFailed = !!videoVisionQc
    && videoVisionQc.passed === false
    && !videoVisionQc.skipped
    && !videoVisionQc.disabled;
  if (!qcFailed) return {};
  const lastSummary = (videoVisionQc.attempts || []).slice(-1)[0]?.summary || 'vision QC fail';
  return {
    status: 'failed',
    renderError: {
      // Short one-liner for logs/ops — the RICH text (identical to what
      // Slack got) lives on visionQc.failureDetail and is what the detail
      // screen renders as "what was wrong with it".
      message: `video ad failed vision QC (no regeneration): ${lastSummary}`,
      stage:   'vision-qc',
      at:      new Date(),
      // The master render itself succeeded and was already billed — this is
      // a post-hoc rejection of an already-paid asset, not an unbilled
      // infra failure.
      charged: true
    }
  };
}

// Shared tail of both engines: upload the rendered mp4, stamp
// Ad.renderUrl, clean up. Retains tempDir on failure when
// BRAND_SCRIPT_RETAIN_TMP is set for post-mortem.
// preserveAdStatus (2026-08-28) — manual RE-TITLE support (routes/brand.js
// retitle-videos / title-still). Every existing caller omits this and gets
// the ORIGINAL, unconditional `status:'draft'` behavior below unchanged.
// A manual retitle commonly targets an ALREADY-DELIVERED ad
// (status:'live') — this function's hard-coded promotion to 'draft' would
// silently un-publish it on every retitle, success or a QC fail, because it
// was written for the "first titling pass right after generation" lifecycle
// and never anticipated being called again on a row that had already left
// it. Found and fixed alongside the adgen-handoff work in
// liquidretail_adgen (same bug, same fix, both repos) — this is a
// pre-existing production defect in the CURRENT in-process retitle path,
// independent of ADGEN_RENDERER_ENABLED. See
// services/handoffContract.js's retitleRequest entry and
// docs/CONTRACT-backend-adgen.md Protocol D.
// LIVE for preview/ops routes in THIS repo (render-script, retitleDriver).
// Mint-time / regenerate / batch-retitle Cloudinary stamp lives in adgen's
// copy. Do not "fix regenerate Cloudinary cleanup" here.
async function uploadRenderAndStamp({ ad, finalPath, tempDir, timings, titlingSnapshot = null, brandName = null, preserveAdStatus = false }) {
  const fs = require('fs');
  const { uploadFileToCloudinary } = require('./cloudinaryService');
  const Ad = require('../models/Ad');
  const { adStage } = require('./adStage');
  try {
    adStage(ad._id, `uploading titled video (${ad.aspectRatio || 'video'})`);
    // Stream straight from disk (efficiency finding #4) instead of the old
    // fs.promises.readFile(finalPath) -> uploadBufferToCloudinary(buffer, ...)
    // path: that read the whole rendered mp4 into one in-memory Buffer (tens/
    // hundreds of MB for a titled master) only to have uploadBufferToCloudinary
    // immediately re-wrap it in a streamifier Readable for upload_stream.
    // finalPath isn't needed for anything else afterward (only tempDir is,
    // for cleanup below), so there's nothing lost by not buffering it.
    const uploaded = await uploadFileToCloudinary(finalPath, {
      folder:       'liquidretail/brand_script',
      resourceType: 'video',
      overwrite:    true
    });
    const set = {
      renderUrl:  uploaded.secure_url,
      renderedAt: new Date(),
      updatedAt:  new Date()
    };
    if (!preserveAdStatus) {
      // Titling is the last required step — promote to draft here so a
      // mid-titling crash leaves status:'rendering' (or the caller's
      // failure path), not a false draft success with an untitled master.
      // SKIPPED under preserveAdStatus (manual retitle of an already-
      // delivered ad) — see this function's header.
      set.status = 'draft';
    }
    // Rebuild the poster from the TITLED upload. posterUrl was stamped pre-chrome from the raw
    // base video (routes/ads.js), so without this a video ad's poster stays an UNCROPPED,
    // UNTITLED 9:16 still — the wrong aspect and missing the titles — and that poster is the
    // image Meta shows before playback. so_2 lands after the title entrances (~0.3-2s), so the
    // still shows the ad as it actually plays. Same URL-shape trick as
    // renderService.buildPosterFromComposite.
    if (uploaded.secure_url.includes('/video/upload/')) {
      set.posterUrl = uploaded.secure_url
        .replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good/')
        .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
    }
    // Persist the exact titling used for this render (generation-inspector).
    if (titlingSnapshot) set.titlingSnapshot = titlingSnapshot;
    // Post-render vision QC — inspects the pixels we are ABOUT TO SHIP
    // (uploaded.secure_url), same principle as the static path inspecting
    // its actual render rather than an intermediate buffer. Merged into the
    // SAME $set/updateOne below so the renderUrl stamp and its QC verdict
    // commit atomically — no window where a video ad has a renderUrl but a
    // stale/absent visionQc. Never throws (see runVideoVisionQcForAd) and,
    // as of 2026-08-20, always returns a real stamped verdict object — a
    // {skipped:true, disabled:true} stub when the gate is off, a
    // {skipped:true, reason:'vision QC (video) infra error: ...'} stub on
    // an internal throw, or a real pass/fail verdict otherwise. The
    // `if (videoVisionQc)` guard below is therefore belt-and-braces, not
    // load-bearing — kept because runVideoVisionQcForAd's own contract only
    // promises "never throws", not "never returns falsy".
    const videoVisionQc = await runVideoVisionQcForAd({ ad, deliveredUrl: uploaded.secure_url, brandName });
    if (videoVisionQc) {
      set.visionQc = videoVisionQc;
      // Asset is NOT discarded on a real QC fail — renderUrl/posterUrl above
      // are left as-is, so the operator can still see exactly what shipped;
      // buildVideoQcFailureFields only adds status:'failed' + renderError on
      // top. See that function's docstring for the full reasoning.
      // ORDER IS THE INVARIANT, not the assignment. This MUST run after the
      // `status: 'draft'` literal above so Object.assign's key overwrites it
      // inside the SAME object — that overwrite is the entire mechanism that
      // makes a real QC failure win. Move this above `const set = {...}`, or
      // swap which one runs last, and a real QC failure silently ships as
      // 'draft' again with NO test failure: the terminal write's own $in
      // guard (renderer.js / routes/ads.js) only ever sees the already-wrong
      // 'draft' this function handed it. Pinned by a structural harness check
      // (grep for buildVideoQcFailureFields position) precisely because this
      // margin is invisible to any check that only reads the terminal write.
      const qcFailureFields = buildVideoQcFailureFields(videoVisionQc);
      // preserveAdStatus: a retitle QC fail must not take an already-
      // delivered ad down — report the failure (visionQc + renderError
      // above already record it) without touching status. See this
      // function's header.
      if (preserveAdStatus) delete qcFailureFields.status;
      Object.assign(set, qcFailureFields);
    }
    await Ad.updateOne(
      { _id: ad._id },
      { $set: set }
    );
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return { renderUrl: uploaded.secure_url, timings };
  } catch (err) {
    if (!process.env.BRAND_SCRIPT_RETAIN_TMP) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
}

// Remotion path: spec + tokens resolved server-side, composition rendered
// by services/remotionRenderService. Never "no chrome" — the canonical
// preset always exists.
// retitleMode (2026-08-28) — see uploadRenderAndStamp's preserveAdStatus
// header. Threaded through to that call below; this function's own
// failure handling (retry once on the raw plate, else plain throw) needed
// no change — unlike adgen's copy, this repo has no
// stampTitlingFailureAndThrow-style attempt-cap/status-flip machinery on
// the failure path, so a Remotion failure already propagates as a plain
// throw regardless of retitleMode.
async function renderWithRemotionAndSave({ ad, brand, format, presetOverride = null, retitleMode = false }) {
  if (!ad?.veoVideoUrl) {
    const e = new Error('ad has no veoVideoUrl — Grok has not rendered yet');
    e.status = 400;
    throw e;
  }
  const { resolveSpec, buildBrandTokens } = require('./titleSpecService');
  const { renderTitles } = require('./remotionRenderService');

  // Explicit named-preset arg (CLI --preset=) is TIER 0. Funnel stage is
  // NOT a whole-spec replace: it is the intent floor (TIER 2.5) so a
  // persisted Title Studio spec actually applies to staged ads. Thread
  // BOTH into buildMetaForAd and resolveSpec so the quote-slot bind list
  // cannot desync from the composition.
  const resolvedPreset = presetOverride != null && String(presetOverride).trim() !== ''
    ? String(presetOverride).trim()
    : null;
  let intentPreset = null;
  try {
    const { resolveFunnelPresetOverride } = require('./campaignAdsGenerationService');
    intentPreset = resolveFunnelPresetOverride(ad);
  } catch {
    intentPreset = null;
  }
  if (resolvedPreset) intentPreset = null;

  const meta = await buildMetaForAd(ad, brand, { presetOverride: resolvedPreset, intentPreset });
  // Resolve the spec for RENDER. Cascade: explicit presetOverride →
  // persisted ad/product/category/brand titleStyleSpec → brand.titleStylePreset
  // → intentPreset (funnel floor) → canonical. Product/category are
  // fetched so a per-product or per-category spec can win when present.
  let productForSpec = null;
  let categories = [];
  if (ad.productId) {
    try {
      const CatalogProduct = require('../models/CatalogProduct');
      productForSpec = await CatalogProduct.findById(ad.productId).select('titleStyleSpec categoryRef').lean();
      if (productForSpec) {
        const { loadCategoryChainForProduct } = require('./categoryChainService');
        categories = await loadCategoryChainForProduct(productForSpec);
      }
    } catch { /* non-fatal — falls back to brand/canonical */ }
  }
  // SAME pair that buildMetaForAd used for the quote gate.
  const resolved = resolveSpec({
    brand, product: productForSpec, ad, format, categories,
    presetOverride: resolvedPreset, intentPreset,
  });
  const { applyBenefitsPlacement } = require('./videoBenefitsDirector');
  const placed = applyBenefitsPlacement({
    spec: resolved.spec,
    meta,
    format,
    direction: ad.videoTitleDirection,
  });
  const spec = placed.spec;
  const source = placed.sourceSuffix
    ? `${resolved.source}+${placed.sourceSuffix}`
    : resolved.source;
  if (placed.decision && placed.decision.reason !== 'flag-off') {
    console.log(
      `🎬 benefits[ad=${ad._id}]: include=${placed.decision.include} reason=${placed.decision.reason}` +
      (placed.decision.phase ? ` phase=${placed.decision.phase}` : '') +
      (placed.decision.surface ? ` surface=${placed.decision.surface}` : '')
    );
  }
  // Same LayoutInputArtifact tier buildMetaForAd uses — brands without
  // explicit color/font fields still inherit the creative director's
  // brand block (input.brand.primary_color / font_family / …).
  let layoutInputBrand = null;
  try {
    const LayoutInputArtifact = require('../models/LayoutInputArtifact');
    const li = ad.mediaId
      ? await LayoutInputArtifact.findOne({ mediaId: ad.mediaId }).sort({ createdAt: -1 }).select('input.brand').lean()
      : null;
    layoutInputBrand = li?.input?.brand || null;
  } catch {}
  const tokens = await buildBrandTokens(brand, { layoutInputBrand, specFontOverrides: spec.tokenOverrides?.fonts || {} });
  const { resolveTitlePlacementMode, resolveSafeZoneKeyCjs } = require('./plateIntelService');
  const placement = resolveTitlePlacementMode({ brand });
  console.log(`🎨 brandScript[ad=${ad._id}]: engine=remotion format=${format} spec=${source} placement=${placement} fonts=${['heading', 'body', 'quote'].map(r => `${r}:${tokens.fonts[r].family}(${tokens.fonts[r].source})`).join(' ')}`);

  // Face-safe base-plate crop (services/basePlateCropService.js): for a 4:5 ad the base renders
  // at Omni's 9:16 native and BasePlate.jsx objectFit:'cover' centre-crops it blind — measured
  // 131px of head lost on a high head. The resolver returns a liveness-probed Cloudinary c_crop
  // derivative, or ad.veoVideoUrl unchanged on ANY gate/failure. Never throws.
  const { adStage, noteRenderIssue } = require('./adStage');
  adStage(ad._id, `face-safe crop (${ad.aspectRatio || format})`);
  const basePlateCrop = require('./basePlateCropService');
  const basePlate = await basePlateCrop.resolveBasePlateVideoUrl({ ad, format });
  const plateUrl = basePlate.videoUrl || ad.veoVideoUrl;
  if (!basePlate.cropped && basePlate.reason) {
    // Soft note: ad still titles, but the operator can see why heads may be centre-cropped.
    noteRenderIssue(ad._id, {
      message: `face-safe crop skipped: ${basePlate.reason}`,
      stage: 'face-safe-crop'
    });
    adStage(ad._id, `face-safe crop skipped (${basePlate.reason})`);
  }

  // Face keep-out for plateHints: reuse Ad.basePlate detection when the crop
  // path already paid for it; otherwise (vertical full-frame) detect once and
  // cache. TITLE_FACE_KEEPOUT=false → null → bands stay avoid:false.
  // Never throws — keep-out is legibility intelligence, not a render gate.
  let faceKeepOut = null;
  try {
    faceKeepOut = await basePlateCrop.ensureFaceDetectionForKeepOut({ ad, format });
  } catch (err) {
    console.warn(`   ⚠️  brandScript[ad=${ad._id}]: face keep-out resolve failed (${err.message})`);
  }

  // platformFormat drives YT safe-zone selection for PMax video only
  // (verticalYt/landscapeYt/squareYt). Canvas `format` stays the composition
  // id + titleStyleSpec key. Absent/unknown platformFormat → Meta zones.
  const platformFormat = ad?.platformFormat || null;
  // safeZoneKey: the surface-aware key plateIntelService.bandsFor needs to
  // sample the strip THIS surface's copy actually paints (backend #307).
  // MUST be resolved here — analyzePlate/applyFaceKeepOut run entirely on
  // the CJS side (this file -> remotionRenderService -> plateIntelService),
  // never inside the ESM Remotion render tree, so there is no fallback
  // resolution downstream the way Canonical.jsx's own titling PLACEMENT has
  // (it calls the real resolveSafeZoneKey itself when no key is passed).
  // Without this line, #307's bandsFor(safeZoneKey) always received
  // `undefined` and silently fell back to the old one-surface BANDS literal
  // on every real render — the exact gap this change closes.
  const safeZoneKey = resolveSafeZoneKeyCjs({ format, platformFormat });

  let result;
  try {
    adStage(ad._id, `titling ${ad.aspectRatio || format}`);
    result = await renderTitles({
      videoUrl:  plateUrl,
      meta,
      spec,
      tokens,
      format,
      platformFormat,
      safeZoneKey,
      brandName: brand?.name,
      adId:      String(ad._id),
      brand,
      placementMode: placement,
      // Cropped plate: face boxes must be mapped through cropRect (source→plate).
      faceKeepOut: faceKeepOut
        ? {
            ...faceKeepOut,
            cropRect: basePlate.cropped
              ? (basePlate.rect || faceKeepOut.cropRect || null)
              : null,
          }
        : null,
    });
  } catch (err) {
    // A cropped-plate failure must NEVER cost the titles: renderBrandScriptAndSave's callers
    // treat chrome as best-effort, so an unhandled throw here ships the raw UNTITLED 9:16
    // master as the deliverable — strictly worse than a titled-but-centre-cropped ad. Retry
    // once with the raw plate; only a raw-plate failure propagates.
    if (basePlate.cropped && plateUrl !== ad.veoVideoUrl) {
      console.warn(`   ⚠️  brandScript[ad=${ad._id}]: titling failed on the cropped plate (${err.message}) — retrying once with the raw plate`);
      result = await renderTitles({
        videoUrl:  ad.veoVideoUrl,
        meta, spec, tokens, format,
        platformFormat,
        safeZoneKey,
        brandName: brand?.name,
        adId:      String(ad._id),
        brand,
        placementMode: placement,
        // Raw plate = source frame; identity mapping (no cropRect).
        faceKeepOut: faceKeepOut ? { ...faceKeepOut, cropRect: null } : null,
      });
    } else {
      throw err;
    }
  }
  return uploadRenderAndStamp({
    ad, finalPath: result.finalPath, tempDir: result.tempDir, timings: result.timings,
    brandName: brand?.name || null,
    preserveAdStatus: retitleMode,
    titlingSnapshot: {
      engine: 'remotion',
      format,
      spec: { source, id: spec?.id || null, version: spec?.version || null },
      placement,
      meta,
      basePlate: basePlate.cropped
        ? { cropped: true, rect: basePlate.rect }
        : { cropped: false, reason: basePlate.reason || null },
      capturedAt: new Date()
    }
  });
}

// End-to-end: render the brand's chosen path over the ad's Grok video,
// upload to Cloudinary, update Ad.renderUrl. Returns the new URL +
// timings. Caller decides how to handle errors — this helper doesn't
// swallow them, so both fatal (pipeline) and non-fatal (script preview)
// call sites can choose behavior.
//
// retitleMode (2026-08-28): pass true for a MANUAL retitle of an
// already-delivered ad (routes/brand.js retitle-videos / title-still) so
// the terminal write preserves the ad's current status instead of forcing
// 'draft' — see uploadRenderAndStamp's preserveAdStatus header.
async function renderBrandScriptAndSave({ ad, brand, presetOverride = null, retitleMode = false }) {
  const engineChoice = resolveTitlingEngine(brand, ad);
  if (engineChoice.engine === 'remotion') {
    return renderWithRemotionAndSave({ ad, brand, format: engineChoice.format, presetOverride, retitleMode });
  }
  const retired = new Error('canvas titling retired — titling is Remotion (Title Studio)');
  retired.status = 410;
  throw retired;
}

module.exports = {
  renderBrandScript,
  renderBrandScriptAndSave,
  buildMetaForAd,
  // Exported for scripts/verifyAdVisionQcSurfacing.js — the gate-off early
  // return is the exact thing that shipped 39/39 ads uninspected in
  // production, and it's cheap enough (no image/video generation, just
  // Mongo lookups + one vision call when the gate IS on) to drive directly
  // with the require-layer model stubs the harness already uses elsewhere.
  runVideoVisionQcForAd,
  // Exported for scripts/verifyVideoQcVerdictSurvives.js — that harness used
  // to prove the Object.assign(set, buildVideoQcFailureFields(...)) merge
  // order via a source-text scan of this function's body, hardened across
  // three rounds against decoys and a resurrecting assignment. An
  // adversarial pass then found six shapes (findByIdAndUpdate,
  // Ad.collection.updateOne, a $set built as a variable, a computed key, a
  // backtick, a later assignment in an uncovered spot) that still clobber
  // the verdict while reading as green. Exporting this lets the harness call
  // the real function with Cloudinary/vision-QC/Ad stubbed and assert on the
  // ACTUAL Ad.updateOne payload instead — immune to all of the above and to
  // any future shape, because it never reads source.
  uploadRenderAndStamp,
  // Pure — exported for the same harness. A real (non-skipped/disabled) QC
  // failure now delivers status:'failed' instead of a normal draft (owner
  // decision 2026-08-20); this is the ONE function every terminal video-ad
  // write path (uploadRenderAndStamp's titled path) goes through, so none
  // of them can drift on what "failed vision QC" means.
  buildVideoQcFailureFields,
  // Re-export for harnesses that pin funnel-preset threading without
  // pulling the whole generation service.
  resolveFunnelPresetOverride: (ad) => {
    try {
      return require('./campaignAdsGenerationService').resolveFunnelPresetOverride(ad);
    } catch {
      return null;
    }
  },
  cleanProductNameForDisplay,
  gateLayoutInputQuotes,
  resolveBrandRenderer,
  resolveTitlingEngine,
  isVerticalFormat,
  isLandscapeFormat,
  isSquareFormat,
  classifyFormat,
  BRAND_SCRIPT_FIELD,
};
