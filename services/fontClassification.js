'use strict';
/**
 * fontClassification.js — the ONE serif-vs-sans classifier, shared by the
 * VIDEO titling path (services/fontResolverService.js) and the STATIC
 * image-gen prompt path (services/directImageRenderService.js).
 *
 * WHY THIS MODULE EXISTS (2026-08-20)
 * ----------------------------------
 * The two pipelines each carried a hand-copied duplicate of one regex, with
 * paired comments admitting they "must stay aligned" and no mechanism making
 * that true — the static copy's own header called it "duplicated by hand".
 * The regex is a pure string function, so sharing it crosses NO architectural
 * boundary: the deliberate rule that static must not resolve brand font
 * FILES over the network (see typefaceDirectiveForBrand's header) is about
 * I/O, not about agreeing on what the word "serif" means. This module is
 * pure — no I/O, no network, no DB, no require of either pipeline — so both
 * can depend on it without either depending on the other.
 *
 * THE DEFECT THAT FORCED IT (Marine Layer 2, from PR #261's §5 follow-up)
 * ----------------------------------------------------------------------
 * Classifying a typeface by pattern-matching its FAMILY NAME cannot work in
 * general, and measurably failed on a real ingested brand font. Marine
 * Layer's own site serves "Seriously Nostalgic", a Didone-style display
 * SERIF. The name matches no serif keyword ("serio…" and "serif…" diverge at
 * the 5th character), so the static prompt instructed gpt-image-2 to use a
 * "clean, modern sans-serif" for a font the VIDEO path — which loads the
 * real file and therefore never has to guess — was correctly rendering as a
 * serif. Same brand, opposite typeface, purely because one pipeline guessed
 * from a string.
 *
 * WHAT WAS MEASURED BEFORE PICKING THIS DESIGN (all three, on real files)
 * ----------------------------------------------------------------------
 * 1. OS/2 `panose` + `sFamilyClass` (the obvious "inspect the file itself"
 *    answer) are UNUSABLE in practice. Probed across the 28 real woff2 files
 *    in services/brandScripts/assets/webfonts plus Marine Layer's own live
 *    file: `sFamilyClass` is 0 (unset) on ALL of them, and panose's
 *    serif-style byte is unset on every known serif in the corpus — Playfair
 *    Display, EB Garamond and Lora all report [0,0,…], Newsreader [2,0,…].
 *    Google's v2 subsets zero it out. Decisively, "Seriously Nostalgic"
 *    ITSELF — the font in the bug report — has panose all-zeros and
 *    sFamilyClass 0, so file-metadata inspection returns NOTHING for the one
 *    case it would have needed to fix. It was not implemented for that
 *    reason, and should not be revisited without re-measuring first.
 * 2. The font's internal `name` table adds no structural signal either — it
 *    only restates names ("Self Modern", designer "Lucas Le Bihan").
 * 3. The brand's OWN STYLESHEET states the answer, first-party and for free
 *    (subject to the precedence below — it fills the keyword list's gaps
 *    rather than overriding its positive matches):
 *    `font-family: Seriously Nostalgic, serif`. The CSS generic sitting next
 *    to the family IS the site author's own classification of their own
 *    typeface. brandFontIngestService already parses these declarations and
 *    was discarding the generic (`firstConcreteFamily` skips past it by
 *    design). Capturing it is strictly better than any name heuristic: it is
 *    evidence rather than a guess, and it needs no keyword treadmill.
 *
 * PRECEDENCE — and why the CSS generic does NOT outrank a keyword match
 * ---------------------------------------------------------------------
 *   1. a positive SERIF_HINTS match on the family name → 'serif'
 *   2. a stored first-party CSS generic                → its class
 *   3. 'sans-serif'                                    → unchanged default
 *
 * The obvious ordering — first-party evidence beats a keyword guess — was
 * REJECTED on purpose, because it can make a currently-correct brand wrong.
 * Sloppy fallbacks are real: `font-family: Playfair Display, sans-serif`
 * declares a sans fallback for an unambiguous serif, and letting the generic
 * win there would flip a brand the keyword list already gets right. On a
 * prompt pipeline this fragile (PR #61's video-prompt hardening was rolled
 * back in full — CLAUDE.md §00) trading a known-correct answer for a
 * differently-sourced one is a bad bet.
 *
 * Read tier 1 precisely: it is not "the name heuristic wins", it is "a
 * RECOGNISED SERIF TYPE NAME wins". The name heuristic's 'sans-serif' return
 * is the ABSENCE of a signal, not evidence of a sans face — which is exactly
 * the gap tier 2 fills, and exactly why Marine Layer is fixed by it.
 *
 * The property this ordering buys is testable, and is tested: no family that
 * classifies today via a positive keyword match can change answer, for ANY
 * generic. The only brands whose classification moves are those that were
 * falling through to the bare sans default — i.e. those we had no evidence
 * about at all. That is the entire blast radius.
 *
 * Known remaining gap, deliberately not addressed: a MIS-matching keyword
 * still wins. "Libre Franklin" is a sans caught by the `libre` keyword (which
 * is there for Libre Baskerville), so it classifies serif and its site's
 * `sans-serif` generic cannot correct it. That is pre-existing behaviour, not
 * a regression, and fixing it means editing the keyword list — which needs
 * its own measured change, not a silent reordering here.
 */

/**
 * Families we treat as serif for CSS-fallback purposes. Historically lived
 * twice — once here in spirit as fontResolverService.SERIF_HINTS, once
 * hand-copied into directImageRenderService.FONT_SERIF_HINTS. Both now read
 * THIS constant, so the "must stay aligned" comments they carried are
 * structurally true instead of aspirational.
 *
 * Deliberately NOT widened as part of the Marine Layer fix. Adding keywords
 * is the treadmill this module exists to get off, and every keyword added
 * here silently re-classifies every brand whose font name happens to contain
 * it — a cross-brand change to a fragile prompt path, in exchange for
 * catching one more name. The generic-capture tier above is the general fix.
 */
const SERIF_HINTS = /serif|playfair|lora|cormorant|garamond|fraunces|caslon|bodoni|didot|georgia|times|libre|crimson|merriweather|spectral|eb garamond|prata|domine|slab|arvo|marcellus|italiana|cinzel/i;

/**
 * CSS generic font families, as they may legally appear in a font-family
 * stack. Kept here (not in the ingest service) so the parser that CAPTURES
 * generics and the classifier that CONSUMES them cannot drift apart on which
 * tokens count as generic.
 *
 * `inherit`/`initial`/`unset` are CSS-wide keywords rather than generics, but
 * they appear in the same position and must likewise never be mistaken for a
 * concrete family name — brandFontIngestService has always grouped them here.
 */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'inherit', 'initial', 'unset'
]);

/**
 * CSS-wide keywords: generic-position tokens that carry NO typographic
 * meaning at all. Separated from GENERIC_FAMILIES because a stack ending in
 * `inherit` tells us nothing, whereas one ending in `serif` tells us
 * everything.
 */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset']);

/**
 * Which serif/sans class each CSS generic implies.
 *
 * `monospace`/`ui-monospace` and `fantasy` map to NULL on purpose — not to
 * 'sans-serif'. Monospace is an orthogonal axis (Courier is a monospace
 * SERIF), and `fantasy` is undefined-by-spec; claiming either implies
 * sans-serif would manufacture a confident answer out of no evidence and
 * could OVERRIDE a correct name-based guess. Null means "no signal", which
 * correctly falls through to the next precedence tier.
 *
 * `cursive` maps to 'serif' to match the convention already established for
 * the video path, where scripts are treated as serif-intent for the
 * serif/sans binary (fontResolverService's LIBRARY_SERIF_FACES lists Great
 * Vibes, Dancing Script, Pacifico and Caveat as serif faces — "the Great
 * Vibes convention"). A high-contrast script is far closer to an editorial
 * serif than to a grotesque, and disagreeing with the video path here is
 * exactly the split this module exists to close.
 */
const GENERIC_TO_CLASS = {
  serif: 'serif',
  'ui-serif': 'serif',
  cursive: 'serif',
  'sans-serif': 'sans-serif',
  'ui-sans-serif': 'sans-serif',
  'system-ui': 'sans-serif',
  monospace: null,
  'ui-monospace': null,
  fantasy: null,
};

/**
 * The comparison key for a font family name: trimmed, internal runs of
 * whitespace collapsed, lowercased.
 *
 * Collapsing INTERNAL whitespace is not cosmetic. A stylesheet may declare
 * `font-family: Seriously   Nostalgic, serif` (two spaces), which the CSS
 * parser treats as the same family as the `@font-face` name `Seriously
 * Nostalgic` — but a `trim()`-and-lowercase comparison does not, so the
 * generic gets stored under a key the consumer never looks up and the fix
 * silently does nothing. Both the ingest-side vote and the read-side lookup
 * key on THIS function so they cannot disagree.
 */
function normalizeFamilyKey(family) {
  return String(family || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** True when `token` sits in generic position (incl. CSS-wide keywords). */
function isGenericFamily(token) {
  return GENERIC_FAMILIES.has(String(token || '').trim().toLowerCase());
}

/**
 * 'serif' | 'sans-serif' | null for a single CSS generic token.
 * Null for unknown tokens, mono/fantasy, and the CSS-wide keywords.
 */
function classFromGeneric(generic) {
  const key = String(generic || '').trim().toLowerCase();
  if (!key || CSS_WIDE_KEYWORDS.has(key)) return null;
  return GENERIC_TO_CLASS[key] || null;
}

/**
 * 'serif' | 'sans-serif' from a family NAME alone — the legacy heuristic,
 * behaviour-identical to what fontResolverService.fallbackFor has always
 * returned. Never null: the sans default is the terminal tier.
 *
 * Kept deliberately naive. verifyFontFallback.js PINS
 * fallbackFor('Self Modern') === 'sans-serif' and documents it as "the naive
 * heuristic by design" — the video path corrects such names through its own
 * curated LIBRARY_SUBSTITUTIONS classification table, not by growing this
 * regex. Do not "fix" a name here without reading that harness first.
 */
function classFromFamilyName(family) {
  return SERIF_HINTS.test(String(family || '')) ? 'serif' : 'sans-serif';
}

/**
 * The classifier. Returns 'serif' | 'sans-serif' — never null, because both
 * consumers must commit to one answer (an absent answer is what let six
 * independent gpt-image-2 calls each improvise a different typeface, the
 * defect verifyStaticTypefaceDeterminism.js exists to prevent).
 *
 * See the PRECEDENCE section in this file's header before reordering these
 * two lines — the ordering is a deliberate blast-radius decision, not the
 * obvious "freshest evidence wins".
 *
 * @param {object}  input
 * @param {string?} input.family  the typeface's family name
 * @param {string?} input.generic a CSS generic captured from the BRAND'S OWN
 *   stylesheet beside that family (e.g. 'serif' from
 *   `font-family: Seriously Nostalgic, serif`). Decides the answer whenever
 *   the family name carries no recognised serif signal of its own.
 * @returns {'serif'|'sans-serif'}
 */
function classifyTypeface({ family = null, generic = null } = {}) {
  // A recognised serif type name is a specific claim about this face and is
  // never overridden. Note classFromFamilyName cannot express "no opinion",
  // so the positive test is done directly here.
  if (SERIF_HINTS.test(String(family || ''))) return 'serif';
  return classFromGeneric(generic) || 'sans-serif';
}

/**
 * The first-party generic recorded for `family` on this brand, or null.
 *
 * Reads the per-role generics brandFontIngestService now votes into
 * Brand.websiteFontUsage, and returns one ONLY when the role's winning family
 * is the family being asked about. That guard matters: a storefront commonly
 * sets a serif display face on headings and a grotesque on body, so applying
 * the heading's generic to the body family (or vice versa) would confidently
 * assert the wrong class. Roles are checked heading → body → button, matching
 * the priority the ingest scorer already gives them.
 *
 * @param {object?} brand  a Brand document (or plain object)
 * @param {string?} family the family whose classification is wanted
 * @returns {string|null} a CSS generic token, or null when none applies
 */
function storedGenericForFamily(brand, family) {
  const usage = brand && typeof brand === 'object' ? brand.websiteFontUsage : null;
  if (!usage || typeof usage !== 'object') return null;
  const want = normalizeFamilyKey(family);
  if (!want) return null;
  // Return the first role that matches this family AND actually recorded a
  // generic — NOT simply the first role that matches. A face is often used in
  // more than one role, and only some of those declarations carry a fallback:
  // heading may name the family with no generic while body names the same
  // family with one. Returning null on the first bare match would throw away a
  // classification the brand did state.
  for (const role of ['heading', 'body', 'button']) {
    if (normalizeFamilyKey(usage[role]) !== want) continue;
    const generic = usage[`${role}Generic`];
    if (generic) return String(generic);
  }
  return null;
}

/**
 * True for dingbat / glyph-icon families. These are not typefaces: they
 * exist so CSS `content:"\e90x"` on a ::before/::after can draw a chevron
 * or a spinner. They must never win a heading/body/button role or be named
 * to an image model as the brand's own face.
 *
 * Pattern, not a name list. Storefronts invent new widget-icon families
 * (`oke-widget-icons`, `swiper-icons`) faster than any allowlist; a family
 * whose name is the word `icon`/`icons` (with the usual separators) is an
 * icon font, and a brand display face is not. `Iconic` does not match —
 * the trailing `ic` keeps it from being the word `icon`.
 */
function isIconFontFamily(family) {
  const lower = String(family || '').trim().toLowerCase();
  if (!lower) return false;
  if (/(?:^|[^a-z0-9])(?:icons?|glyphicons?|font[-\s]?awesome|material[-\s]?icons?|icomoon)(?:[^a-z0-9]|$)/i
    .test(lower)) {
    return true;
  }
  // Dingbat / LED-display junk that is not a brand typeface. Gymshark's
  // ingested `digital-7_monomono` otherwise wins customFonts[0] and gets
  // named to gpt-image-2 as the headline face.
  return /(?:^|[^a-z0-9])(?:digital-?7|7seg(?:ment)?|seven-?seg(?:ment)?|led)(?:[^a-z0-9]|$)/i
    .test(lower);
}

module.exports = {
  SERIF_HINTS,
  normalizeFamilyKey,
  GENERIC_FAMILIES,
  CSS_WIDE_KEYWORDS,
  GENERIC_TO_CLASS,
  isGenericFamily,
  classFromGeneric,
  classFromFamilyName,
  classifyTypeface,
  storedGenericForFamily,
  isIconFontFamily,
};
