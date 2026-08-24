'use strict';

/**
 * ONE definition of "may this star rating print on an ad".
 *
 * Shared by the static path (directImageRenderService.buildIntentData) and the
 * video chrome path (brandScriptExecutor.buildMetaForAd → Remotion Canonical).
 * Owner rule is about star display generally, not one surface — a raw 3.2 must
 * not burn into a Reel either.
 *
 * Owner rule (verbatim, 2026-08-04): "anything above a 4.4 is acceptable
 * actually, brand stars can use the brand volume exception." This SUPERSEDES the
 * earlier rule, also verbatim, which read: "we only use stars over 4.5".
 *
 * WHY THE CONSTANT IS 4.39 AND NOT 4.4. The gate is strictly greater than this
 * floor, applied to the ROUNDED one-decimal DISPLAY value. A displayed 4.4 must
 * print, and `4.4 > 4.4` is false — so 4.4 as the constant would refuse exactly
 * the case the owner asked for. 4.39 follows the convention already established
 * by RATING_STAR_VOLUME_MIN, which is 4.19 precisely so a displayed 4.2 passes.
 */
const RATING_STAR_MIN = 4.39;

/**
 * Longest product label allowed on the rating line. The line sits at ~0.82x body
 * size beneath the stars, so it has far less room than the product-name slot.
 */
const PRODUCT_ATTRIBUTION_CAP = 28;

/** Trim to `cap` on a word boundary. Returns null for anything unusable. */
function truncateWordSafe(value, cap) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length <= cap) return s;
  const cut = s.slice(0, cap);
  const sp = cut.lastIndexOf(' ');
  // Only fall back to a hard cut when there is no space to break on, so a single
  // very long word still yields something rather than an empty label.
  return (sp >= Math.floor(cap * 0.5) ? cut.slice(0, sp) : cut).trim() || null;
}

/**
 * Product-tier volume exception (owner, verbatim):
 *   "if the count is large (greater than 5000), than stars above 4.19 is allowed"
 *
 * Both comparisons are STRICT (`>`), as written. Both are applied to the
 * ROUNDED one-decimal display value (same convention as RATING_STAR_MIN), so
 * the viewer never sees a number the floor would forbid.
 *
 * BOUNDARY CONSEQUENCE (not a bug): a raw 4.15 displays as "4.2" and therefore
 * PASSES a 4.19 floor (`4.2 > 4.19`). The gate is deliberately on what the
 * VIEWER READS, matching the existing `>4.5` convention. The effective raw
 * cutoff under one-decimal rounding is therefore 4.15 (anything that rounds
 * to 4.1 fails; anything that rounds to 4.2 with count > 5000 passes). Do not
 * "fix" this by asserting raw 4.19 refuses — raw 4.19 also displays as 4.2.
 *
 * Count floor is exclusive: 5000 does NOT unlock; 5001 does.
 *
 * SCOPE: product AND brand as of 2026-08-04 — the owner enabled the brand path
 * (see BRAND_VOLUME_EXCEPTION_ENABLED below).
 */
const RATING_STAR_VOLUME_MIN = 4.19;
const RATING_STAR_VOLUME_COUNT_MIN = 5000;

/**
 * One-line switch: apply the volume exception to brand stars too.
 *
 * ON as of 2026-08-04. Owner: "brand stars can use the brand volume exception",
 * asked to mirror product EXACTLY. He was shown the consequence and chose it:
 * brand stars can now print down to a DISPLAYED 4.2 when the brand review count
 * exceeds 5000. Concretely, on today's data that admits BabyBoo (4.3 / 17,645)
 * and still refuses GymShark (3.3) no matter how many reviews back it — volume
 * widens the exception's REACH, never its floor.
 *
 * The brand fail path (count without stars, beside a brand-side quote) still
 * applies to everything that misses both bars.
 */
const BRAND_VOLUME_EXCEPTION_ENABLED = true;

/**
 * Quote tier → which NUMBER snapshot may print beside it.
 *
 * Owner decision 2026-08-03: category sits on the BRAND side, accepting that a
 * category quote beside a catalog-wide count is a looser claim than product.
 * Edit THIS table only if that policy changes — do not scatter tier checks
 * across renderers.
 *
 *   product  → product numbers only
 *   comment  → product numbers only   (product-scoped social comments)
 *   category → brand numbers only     (owner: brand side — looser claim accepted)
 *   brand    → brand numbers only
 */
const QUOTE_TIER_NUMBER_SIDE = Object.freeze({
  product:  'product',
  comment:  'product',
  category: 'brand',
  brand:    'brand',
});

/**
 * Format a raw rating for display, or withhold it.
 *
 * WHY the gate tests the ROUNDED (one-decimal) value, not the raw one:
 * a raw gate of `rating_value > 4.5` lets 4.51 through, then `toFixed(1)`
 * prints "4.5" — the exact value the owner rule forbids. Confirmed by
 * execution against the old static gate:
 *   rating_value=4.51  passesGate=true  -> displays "4.5"
 *   rating_value=4.54  passesGate=true  -> displays "4.5"
 *   rating_value=4.55  passesGate=true  -> displays "4.5"
 * Compute the displayed number first, then require THAT to be
 * `> starMin` and `<= 5`. Upper bound still catches a 0–100 vendor
 * scale that would otherwise render as "87 stars".
 *
 * BOUNDARY CONSEQUENCE for a non-default floor (e.g. volume 4.19): a raw 4.15
 * displays as "4.2" and therefore passes `displayed > 4.19`. The gate is on
 * what the VIEWER READS, matching the existing `>4.5` convention; the
 * effective raw cutoff under one-decimal rounding is 4.15. Not a bug.
 *
 * @param {*} raw  Candidate rating (must be a finite number to print).
 * @param {number|{starMin?:number}} [opts] Optional star floor. A bare number
 *   or `{ starMin }` both work. Default is RATING_STAR_MIN (today's behaviour).
 * @returns {string|undefined} display string (always one decimal, e.g. "4.6"
 *   or "5.0") or undefined to withhold.
 */
function formatDisplayRating(raw, opts) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const starMin = (opts != null && typeof opts === 'object')
    ? (typeof opts.starMin === 'number' ? opts.starMin : RATING_STAR_MIN)
    : (typeof opts === 'number' ? opts : RATING_STAR_MIN);
  const displayed = Number(raw.toFixed(1));
  if (!(displayed > starMin && displayed <= 5)) return undefined;
  // ALWAYS one decimal. `String(displayed)` drops the trailing zero on a
  // perfect 5 → "5", and the static prompt then asks the image model for
  // "5 ★" (see staticAdIntents text slots). Measured on a 27-ad Pelagic
  // batch: that string typesets as a large numeral beside a single star
  // with a wide gap, which a reader parses as a broken widget, not a
  // rating. `toFixed(1)` keeps "5.0" so the requested string is "5.0 ★".
  // Do NOT `String(Number(n.toFixed(1)))` — that is the bug.
  return displayed.toFixed(1);
}

/**
 * Normalize a review count for display. Positive finite numbers only.
 * @returns {number|null}
 */
function normalizeReviewCount(raw) {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * A brand's display label — domain from websiteUrl, else the brand name.
 *
 * **NO LONGER ON THE PROOF-LINE PATH (2026-08-03).** This used to supply the
 * attribution appended to a brand review count (`41000 reviews · gymshark.com`).
 * The owner replaced that with the fixed BRAND_SCOPE_LABEL below, so nothing this
 * returns reaches rendered ad copy any more — see that constant for why (Meta
 * already draws page identity; the brand-NAME fallback collided with the
 * "no added brand wordmark" absence rule; a hostname is punctuation-dense for an
 * image model).
 *
 * Kept rather than deleted because it is a legitimate utility and a future surface
 * (an endcard, a link line) may legitimately want a brand's domain. But it is NOT
 * the answer to "how do we attribute a review count" — reach for BRAND_SCOPE_LABEL.
 * `scripts/verifyPostPilotBatch.js` A7/A8 pin its domain-then-name preference as a
 * utility contract, not as rendered output.
 */
function brandAttributionLabel(brand) {
  if (!brand || typeof brand !== 'object') return null;
  const rawUrl = brand.websiteUrl || brand.brandWebsiteUrl || null;
  if (rawUrl && typeof rawUrl === 'string' && rawUrl.trim()) {
    try {
      const href = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl.trim()}`;
      const host = new URL(href).hostname.replace(/^www\./i, '');
      if (host) return host;
    } catch { /* fall through to name */ }
  }
  const name = brand.name && String(brand.name).trim();
  return name || null;
}

/**
 * Build the brand-tier reviewsText string. Both brand branches (stars+count, and
 * count-only via allowBrandCountWithoutStars) share this ONE implementation, so the
 * same count reads identically whether or not stars print alongside it.
 * @returns {string|null}
 *
 * SCOPE LABEL, not brand identity — owner decision 2026-08-03.
 *
 * A brand-tier count printed bare reads as THIS PRODUCT's reviews, which is the
 * defect that started the whole tier-coherence exercise. So the count must always
 * carry a qualifier. It used to carry the brand's DOMAIN (`41000 reviews ·
 * gymshark.com`); the owner replaced that with a plain scope phrase, and it is a
 * better answer for three reasons worth recording:
 *
 *   1. Meta already draws the advertiser's page identity around the creative, so
 *      burning the domain in repeated information the viewer already had.
 *   2. `brandAttributionLabel` FALLS BACK TO THE BRAND NAME when a brand has no
 *      websiteUrl — so for those brands we were typesetting "Gymshark" into the
 *      pixels while the same static prompt's `absences` list says "no added brand
 *      logo, wordmark or lockup anywhere in the scene". A self-contradictory prompt,
 *      the same class as the CTA and crossfade/dissolve contradictions this repo has
 *      already been bitten by.
 *   3. A hostname is punctuation-dense (dots, no spaces) and static hands verbatim
 *      strings to an image model whose text fidelity is the whole game. Plain words
 *      are lower risk than a domain.
 *
 * UNCONDITIONAL on purpose. The old formatter dropped the qualifier entirely when
 * attribution was unknown, emitting a bare "12 reviews" — the exact unscoped form the
 * qualifier exists to prevent. There is no such hole now: a brand-tier count is always
 * labelled as one.
 */
const BRAND_SCOPE_LABEL = 'brand reviews';

function formatBrandReviewsText(rc) {
  if (rc == null) return null;
  // Singular still reads as brand-scoped: "1 brand review".
  return rc === 1 ? `1 brand review` : `${rc} ${BRAND_SCOPE_LABEL}`;
}

/**
 * Compact count for image-model typesetting. Full "41000 reviews · domain"
 * is a fidelity hazard on static (gpt-image-2 mangles long digit strings).
 * Video keeps the full form via formatBrandReviewsText / product reviewsText.
 * @returns {string|null}
 */
function formatCompactCount(n) {
  if (n == null) return null;
  const v = normalizeReviewCount(n);
  if (v == null) return null;
  if (v < 1000) return String(v);
  const k = v / 1000;
  const rounded = Math.round(k * 10) / 10;
  return `${rounded}k`;
}

function formatProductReviewsText(rc) {
  if (rc == null) return null;
  return `${rc} review${rc === 1 ? '' : 's'}`;
}

function formatProductReviewsTextShort(rc) {
  const c = formatCompactCount(rc);
  return c != null ? `${c} reviews` : null;
}

function formatBrandReviewsTextShort(rc) {
  if (rc == null) return null;
  const c = formatCompactCount(rc);
  if (!c) return null;
  // "41k brand reviews". Same scope label as the long form — the static surface may
  // shorten the NUMBER (image models mangle long strings) but must never drop the
  // qualifier, or a compact count becomes an unscoped claim.
  return `${c} ${BRAND_SCOPE_LABEL}`;
}

/**
 * ATOMIC rating + reviewCount pair resolution.
 *
 * CRITICAL HISTORY: a brand-level cascade tier once mixed sources — a product's
 * 41,000-review count printed next to the brand's 3.3 rating. That path was
 * removed. This resolver is the ONLY brand fallback and is ATOMIC: rating and
 * count always come from the SAME tier (product pair OR brand pair), never
 * mixed. The new brand-count-without-stars outcome below is still tier-atomic
 * — it only ever pairs the brand's own count with the brand's own quote (see
 * the call site gate in buildMetaForAd), never a product-tier quote.
 *
 * Product pair first. If it yields no displayable rating (formatDisplayRating
 * gate), try the brand pair (same gate). When the brand pair is used,
 * reviewsText attributes the count to the brand domain/name so the ad never
 * implies product-level reviews.
 *
 * If brand rating passes but brand count is missing → show rating with NO
 * count (never the product's count).
 *
 * If NEITHER pair clears the star gate (most brands: only 4 of 34 clear
 * >4.5 today — e.g. GymShark sits at 3.3 with 41,000 reviews, AllBirds has
 * no brand rating at all), a failing/missing rating would otherwise mean NO
 * social proof at all. `allowBrandCountWithoutStars` lets the brand's review
 * COUNT print alone (no stars — the owner rule "we only use stars over 4.5"
 * is untouched, see formatDisplayRating) when the caller has independently
 * confirmed the accompanying quote is also brand-tier — count and quote must
 * still come from the same tier, so this must never be turned on next to a
 * product-tier quote.
 *
 * Data source for brand pair (caller's responsibility): Brand.brandReviews
 * ({ rating, reviewCount }) — same Gemini grounded-search snapshot written by
 * enrichBrandFromUrl / productMatchService. Prefer that over averaging
 * CatalogProduct rows (partial coverage, not a true brand aggregate).
 *
 * NOTE: this resolver cannot see the quote. Its "brand wins when product fails"
 * behaviour is correct FOR A RESOLVER THAT CANNOT SEE THE QUOTE. Quote-aware
 * tier coherence is owned by resolveCoherentSocialProof, which withholds the
 * ineligible side's inputs before calling here.
 *
 * @param {boolean} [allowBrandCountWithoutStars=false] Only set true when the
 *   quote alongside this pair is confirmed brand-tier (never product-tier).
 * @param {number} [productStarMin=RATING_STAR_MIN] Optional product star floor
 *   (volume exception passes RATING_STAR_VOLUME_MIN when count clears the
 *   threshold). Brand always uses RATING_STAR_MIN unless brandStarMin is set.
 * @param {number} [brandStarMin=RATING_STAR_MIN] Optional brand star floor
 *   (reserved for BRAND_VOLUME_EXCEPTION_ENABLED overrule).
 * @returns {{ rating: string|null, reviewCount: number|null, reviewsText: string|null, source: 'product'|'brand'|'brand-count'|null }}
 */
function resolveAtomicRatingPair({
  productRating = null,
  productReviewCount = null,
  brandRating = null,
  brandReviewCount = null,
  brandAttribution = null,
  productAttribution = null,
  allowBrandCountWithoutStars = false,
  productStarMin = RATING_STAR_MIN,
  brandStarMin = RATING_STAR_MIN,
} = {}) {
  const productDisplay = formatDisplayRating(productRating, productStarMin);
  if (productDisplay) {
    // Product pair — count from product tier only (may be null).
    const rc = normalizeReviewCount(productReviewCount);
    // NAME THE PRODUCT when the stars are product-level.
    //
    // Owner: *"when there is a product specific star rating, make sure it is next
    // to a product specific quote, or it includes the product name."* The risk is
    // real rather than theoretical: the quote beside these stars can legitimately
    // be brand-tier, because that last-resort fallback is deliberate
    // (layoutInputService's tier ladder). An unlabelled "4.8 ★ · 200 reviews"
    // sitting next to a catalog-wide testimonial reads as though the testimonial
    // were about THIS product. Attributing the count to the product states the
    // scope outright instead of withholding either element — and it mirrors what
    // the brand tier below already does with its domain label.
    let reviewsText = null;
    if (rc != null) {
      // CAPPED. The rating line renders at ~0.82x body size and the renderer caps
      // productName but NOT reviewsText, so an unbounded merchant title
      // ("Women's Ultra Lightweight Performance Moisture-Wicking Trail Running
      // Shoe") would overrun the line. Word-safe so it never cuts mid-word.
      reviewsText = `${rc} review${rc === 1 ? '' : 's'}`;
      const label = truncateWordSafe(productAttribution, PRODUCT_ATTRIBUTION_CAP);
      if (label) reviewsText += ` · ${label}`;
    }
    return {
      rating: productDisplay,
      reviewCount: rc,
      reviewsText,
      source: 'product',
    };
  }

  const brandDisplay = formatDisplayRating(brandRating, brandStarMin);
  if (brandDisplay) {
    // Brand pair — count from brand tier ONLY. Never productReviewCount.
    const rc = normalizeReviewCount(brandReviewCount);
    return {
      rating: brandDisplay,
      reviewCount: rc,
      reviewsText: formatBrandReviewsText(rc),
      source: 'brand',
    };
  }

  if (allowBrandCountWithoutStars) {
    // Neither tier clears the star gate, but a strong brand review COUNT is
    // still honest, strong social proof on its own. Rating stays null (no
    // stars print) — only the count text prints.
    const rc = normalizeReviewCount(brandReviewCount);
    if (rc != null) {
      return {
        rating: null,
        reviewCount: rc,
        reviewsText: formatBrandReviewsText(rc),
        source: 'brand-count',
      };
    }
  }

  return { rating: null, reviewCount: null, reviewsText: null, source: null };
}

/**
 * Product star floor for a pre-bundled product pair: classic >4.5, OR volume
 * exception when count strictly exceeds the threshold.
 * @returns {number}
 */
function productStarFloorForCount(productReviewCount) {
  const rc = normalizeReviewCount(productReviewCount);
  if (rc != null && rc > RATING_STAR_VOLUME_COUNT_MIN) {
    return RATING_STAR_VOLUME_MIN;
  }
  return RATING_STAR_MIN;
}

/**
 * Brand star floor. Default is always RATING_STAR_MIN. Flip
 * BRAND_VOLUME_EXCEPTION_ENABLED to true to reuse the product volume path.
 * @returns {number}
 */
function brandStarFloorForCount(brandReviewCount) {
  if (!BRAND_VOLUME_EXCEPTION_ENABLED) return RATING_STAR_MIN;
  const rc = normalizeReviewCount(brandReviewCount);
  if (rc != null && rc > RATING_STAR_VOLUME_COUNT_MIN) {
    return RATING_STAR_VOLUME_MIN;
  }
  return RATING_STAR_MIN;
}

/**
 * Whether a quote is considered ON FRAME for count-only / tier locking.
 * When renderedQuoteText is supplied, it must match the quote's text or
 * snippet (F4: cascade must not authorize numbers for a different line).
 */
function quotePrintsOnFrame(quote, renderedQuoteText) {
  if (!quote || typeof quote !== 'object') return false;
  const quoteText = String(quote.text || '').trim();
  if (!quoteText) return false;
  const quoteSnippet = quote.snippet != null ? String(quote.snippet).trim() : '';
  // NO DEFAULT. An earlier version fell back to `quoteSnippet || quoteText` when
  // the caller passed nothing, which made the comparison trivially true and turned
  // this guard into a no-op for any caller that forgot the argument — fail-open on
  // the one check standing between a testimonial and a review count we cannot tie
  // to it. The caller must state what actually renders; silence is not proof.
  if (renderedQuoteText == null) return false;
  const rendered = String(renderedQuoteText).trim();
  if (!rendered) return false;
  return rendered === quoteText || (!!quoteSnippet && rendered === quoteSnippet);
}

function emptyCoherentProof(quote, quoteTier) {
  const quoteText = quote ? String(quote.text || '').trim() : '';
  const quoteSnippet = quote && quote.snippet != null
    ? String(quote.snippet).trim() : '';
  return {
    quote: quote && quoteText
      ? { ...quote, text: quoteText, snippet: quoteSnippet || null, tier: quoteTier || null }
      : null,
    quoteTier: quoteTier || null,
    rating: null,
    reviewCount: null,
    source: null,
    reviewsText: null,
    reviewsTextShort: null,
  };
}

/**
 * Pack a coherent decision + both presentation strings. Presentation is a pure
 * function of the same numbers — never a second tier decision.
 */
function packCoherentProof({ quote, quoteTier, rating, reviewCount, source, brandAttribution }) {
  const quoteText = quote ? String(quote.text || '').trim() : '';
  const quoteSnippet = quote && quote.snippet != null
    ? String(quote.snippet).trim() : '';
  const isBrandSide = source === 'brand' || source === 'brand-count';
  const rc = reviewCount;
  return {
    quote: quote && quoteText
      ? { ...quote, text: quoteText, snippet: quoteSnippet || null, tier: quoteTier || null }
      : null,
    quoteTier: quoteTier || null,
    rating: rating || null,
    reviewCount: rc,
    source,
    reviewsText: isBrandSide
      ? formatBrandReviewsText(rc)
      : formatProductReviewsText(rc),
    reviewsTextShort: isBrandSide
      ? formatBrandReviewsTextShort(rc)
      : formatProductReviewsTextShort(rc),
  };
}

/**
 * COHERENT social-proof decision — the ONLY place quote-tier ↔ number-tier
 * pairing is decided. Callers (later): buildMetaForAd (video) and
 * buildIntentData (static). Nothing calls this yet; wiring is a separate change.
 *
 * HARD INVARIANTS (revised shape, owner 2026-08-03):
 *
 * 1. If source ∈ {'product','product-count'} → numbers from the PRODUCT
 *    snapshot only. When a quote is printing, quoteTier ∈ {product, comment}
 *    (from QUOTE_TIER_NUMBER_SIDE). Stars-only with no quote still allows
 *    source:'product' (not product-count).
 *
 * 2. If source ∈ {'brand','brand-count'} → numbers from the BRAND snapshot
 *    only. When a quote is printing, quoteTier ∈ {brand, category}
 *    (category is brand-side by owner decision). Stars-only with no quote
 *    still allows source:'brand' (not brand-count).
 *
 * 3. brand-count and product-count both require a coherent quote ON FRAME.
 *    With no quote, neither count-only outcome unlocks — only stars are
 *    eligible (product first, then brand).
 *
 * 4. NEVER:
 *    - product/comment quote + brand numbers (stars or count)
 *      ⚠️ OWNER-APPROVED EXCEPTION, 2026-08-07 — opt-in ONLY via
 *      `allowLabeledBrandNumbers` (default false), used only by the static
 *      social-proof path. See "THE ONE EXCEPTION" below. Every other caller,
 *      including all of video, still gets this bullet enforced absolutely.
 *    - brand/category quote + product numbers
 *    - rating from tier A + count from tier B
 *    - brand-count / product-count without a coherent quote on frame
 *    - brand stars earned via the volume exception (product-only; see
 *      BRAND_VOLUME_EXCEPTION_ENABLED for the one-line overrule)
 *
 * THE ONE EXCEPTION — `allowLabeledBrandNumbers` (owner directive 2026-08-07).
 *
 * The original rule exists because a brand-wide review count sitting next to one
 * product's testimonial reads as THAT product's review volume. That reasoning is
 * still correct and is why this stays opt-in and default-off.
 *
 * What the owner decided, verbatim: *"I don't want brand level stars to block a
 * comment tier quote. We can have both and clearly demarcate brand level stars…
 * The positive comment is different and better social proof than brand level
 * stars"* and *"include the comment and then use brand level stars and include a
 * 'Brand Reviews' next to the stars."*
 *
 * Why it is safe ENOUGH here, and what actually carries that safety: the
 * misattribution risk is a LABELLING problem, and the label is mechanical, not
 * advisory. Returning source:'brand'/'brand-count' makes packCoherentProof emit
 * reviewsText through formatBrandReviewsText, which always appends
 * BRAND_SCOPE_LABEL ("brand reviews") — so the count cannot reach a surface
 * unscoped. INTENTS.social_proof_led prefers that scoped string over any
 * re-derived unscoped one (staticAdIntents.js), which is what closes the loop.
 *
 * WHY THIS WAS WORTH DOING: measured in production, 7 of 18 ai_social_proof_led
 * renders fell back to objection_resolved because a comment-tier quote had
 * hard-nulled otherwise-usable brand stars, leaving the intent with no rating —
 * and the whole point of that intent is the rating.
 *
 * DO NOT "restore the invariant" by deleting the exception. It is deliberate and
 * owner-confirmed; this repo has precedent (CLAUDE.md §00, the PR #61 rollback)
 * of a later session helpfully undoing an intentional decision. Flip
 * STATIC_BRAND_STARS_WITH_QUOTE=false instead — no deploy needed.
 *
 * HOW R1 closes without changing resolveAtomicRatingPair's contract: this
 * function WITHHOLDS the ineligible side's inputs entirely before delegating
 * to resolveAtomicRatingPair, so a brand/category quote can never reach product
 * numbers, and a product/comment quote can never reach brand numbers UNLESS the
 * caller passes `allowLabeledBrandNumbers` (default false — see "THE ONE
 * EXCEPTION"), in which case it may reach SCOPE-LABELLED brand STARS only, and
 * only after both product attempts have failed. The pair resolver still prefers
 * product then brand when both sides are present (rating-only ads).
 *
 * Inputs are PRE-BUNDLED pairs (product snapshot, brand snapshot) — never two
 * independently-sourced scalars. That is the R2 hole.
 *
 * @param {object} args
 * @param {null|{text?:string,snippet?:string,tier?:string,origin?:string,author_name?:string}} args.quote
 *   Already provenance-gated by the caller. null = no quote on frame.
 * @param {null|{rating?:*,reviewCount?:*}} args.product  Pre-bundled product pair.
 * @param {null|{rating?:*,reviewCount?:*}} args.brand    Pre-bundled brand pair.
 * @param {string|null} [args.brandAttribution]
 * @param {string|null} [args.renderedQuoteText]
 *   The exact string the surface will typeset. **REQUIRED whenever `quote` is
 *   non-null** — it must equal the quote's `text` or its `snippet`, or every number
 *   is withheld.
 *
 *   This JSDoc previously said "when omitted, uses snippet||text", which described
 *   an earlier draft and was left stale by the fix below it — a dangerous lie on a
 *   fail-closed contract, because a caller trusting it would assume omitting the
 *   argument is harmless when in fact it silently suppresses all social proof.
 *   Omitting it now makes `quotePrintsOnFrame` return false, and a quote that is
 *   present but unverifiable withholds numbers rather than falling through to the
 *   rating-only path (that fall-through is how a substituted quote could earn brand
 *   stars). Pinned by N1/N2/N3 in scripts/verifyCoherentSocialProof.js.
 *
 *   Callers with a cascade or bind list between the meta and the pixels (the video
 *   path: `titleSpecValidator` DEFAULT_BIND `quote: ['quoteSnippet','quote']`, itself
 *   overridable per slot, plus `Brand.metaCascades.quoteSnippet`) must resolve that
 *   chain and pass the RESULT. Callers where the string handed over IS what renders
 *   (the static path feeds verbatim strings to the image model, with no cascade and
 *   no bind list) may pass the quote text itself — there, it is a statement of fact,
 *   not ceremony.
 * @returns {{
 *   quote: object|null,
 *   quoteTier: string|null,
 *   rating: string|null,
 *   reviewCount: number|null,
 *   source: 'product'|'product-count'|'brand'|'brand-count'|null,
 *   reviewsText: string|null,
 *   reviewsTextShort: string|null,
 * }}
 */
function resolveCoherentSocialProof({
  quote = null,
  product = null,
  brand = null,
  brandAttribution = null,
  renderedQuoteText = null,
  // OPT-IN, DEFAULT FALSE — see "THE ONE EXCEPTION" in the JSDoc above.
  // Defaulting to false is what makes every existing caller (all of video via
  // buildMetaForAd, and every harness) byte-identical BY CONSTRUCTION rather
  // than by assertion. Only the static social-proof path passes true.
  allowLabeledBrandNumbers = false,
} = {}) {
  const productPair = product && typeof product === 'object' ? product : null;
  const brandPair = brand && typeof brand === 'object' ? brand : null;

  const quoteTier = quote && quote.tier ? String(quote.tier) : null;
  const onFrame = quotePrintsOnFrame(quote, renderedQuoteText);
  const side = (quoteTier && QUOTE_TIER_NUMBER_SIDE[quoteTier]) || null;

  // FAIL CLOSED — and do NOT conflate these two cases, because the first draft of
  // this function did and it reopened the exact hole the function exists to close:
  //
  //   quote === null            → no quote on frame at all. Rating-only social
  //                               proof is legitimate; there is no tier to cohere
  //                               with. Falls through to the branch below.
  //   quote supplied, but either unverifiable against what actually renders, or
  //   carrying no tier stamp     → SOMETHING is printing whose tier we cannot
  //                               vouch for. Numbers must be WITHHELD.
  //
  // The bug: on a mismatch `onFrame` goes false, and without this guard control
  // fell through to the rating-only branch, which passes BOTH product and brand
  // inputs to the resolver. So a product-tier quote whose rendered text had been
  // substituted (a `Brand.metaCascades.quoteSnippet` override — precisely the F4
  // case) could still end up beside brand stars. That is R1, reintroduced through
  // the path meant to prevent it.
  //
  // Note this also makes `renderedQuoteText` effectively REQUIRED whenever a quote
  // is supplied: a caller that omits it cannot prove which line renders, so it
  // gets no numbers. That is deliberate ceremony at the two wiring sites — it
  // converts a silent assumption into an obligation, and an unauthorised number
  // beside a testimonial is a claim we cannot substantiate.
  if (quote && (!onFrame || !quoteTier || !side)) {
    return emptyCoherentProof(quote, quoteTier);
  }

  // ── Quote on frame: tier locks the number side; withhold the other ──
  if (onFrame && quoteTier) {
    if (side === 'product') {
      // Product/comment quote → product numbers first, and product numbers are
      // the ONLY ones that can win here unless the caller passed the opt-in
      // (see "THE ONE EXCEPTION" below, default off). Was "No brand fallback
      // (R1)" — that absolute is no longer true and a stale absolute sitting
      // directly above the branch that contradicts it is how this file gets
      // misread.
      const productRating = productPair ? productPair.rating : null;
      const productReviewCount = productPair ? productPair.reviewCount : null;
      const productStarMin = productStarFloorForCount(productReviewCount);

      const pair = resolveAtomicRatingPair({
        productRating,
        productReviewCount,
        // Withhold brand entirely — resolver must not fall through.
        brandRating: null,
        brandReviewCount: null,
        brandAttribution: null,
        allowBrandCountWithoutStars: false,
        productStarMin,
      });

      // THE LOAD-BEARING GUARD IS THIS WHITELIST, not the withholding above.
      // Both are here on purpose, but they are not equally strong, and a
      // revert-proof pass proved it: backing out the brand-input withholding
      // changed NO observable behaviour, because a `source:'brand'` result
      // reaching this line is discarded here anyway. Deleting THIS check while
      // trusting the withholding would be the dangerous edit — the resolver's
      // documented contract is "brand wins when product fails", so anything that
      // lets brand inputs back in (a refactor, a new caller, a merge) would
      // immediately print brand numbers beside a product quote. Keep both; if you
      // only keep one, keep this.
      if (pair.source === 'product') {
        return packCoherentProof({
          quote,
          quoteTier,
          rating: pair.rating,
          reviewCount: pair.reviewCount,
          source: 'product',
          brandAttribution: null,
        });
      }

      // Stars refused both gates → product count only (requires quote on frame).
      const rc = normalizeReviewCount(productReviewCount);
      if (rc != null) {
        return packCoherentProof({
          quote,
          quoteTier,
          rating: null,
          reviewCount: rc,
          source: 'product-count',
          brandAttribution: null,
        });
      }

      // ── THE ONE EXCEPTION (owner 2026-08-07, opt-in) ───────────────────
      // Product side yielded nothing at all: no product stars, no product
      // count. Rather than withhold every number and let the intent collapse
      // to objection_resolved, fall back to BRAND STARS — but only when the
      // caller explicitly opted in, and only ever scope-LABELLED.
      //
      // Ordering is load-bearing: this sits AFTER both product attempts, so a
      // product-tier number always wins when one exists. The exception can only
      // ever ADD proof where there was none — it can never displace product
      // numbers with brand ones.
      //
      // THREE CONSTRAINTS, each closing a hole two independent adversarial
      // passes found in the first draft of this block. Do not relax any of them
      // without re-reading those findings:
      //
      //   (a) `=== true`, not truthiness. The first draft used `if (flag)`, so a
      //       caller forwarding a raw env STRING opted in on the literal
      //       "false" (probed: it returned brand stars). The static caller
      //       coerces correctly today, but the chokepoint must not depend on
      //       every future caller being careful.
      //
      //   (b) A normalized brand COUNT is REQUIRED. The scope label is only
      //       mechanical because packCoherentProof derives reviewsText from the
      //       count via formatBrandReviewsText — and that returns null for a
      //       null count. So a stars-only brand pair (rating 4.7, count null)
      //       produced source:'brand' with reviewsText:null, and
      //       staticAdIntents' RATING line then fell through to a bare
      //       "4.7 ★" sitting beside a product/comment testimonial with NO
      //       "brand reviews" qualifier — exactly the misattribution the owner's
      //       "Brand Reviews next to the stars" instruction exists to prevent,
      //       and exactly what this exception's own docs wrongly claimed was
      //       impossible. No count → no label vehicle → refuse outright.
      //
      //   (c) allowBrandCountWithoutStars STAYS FALSE here. resolveAtomicRating-
      //       Pair's own contract says to set it true ONLY when the accompanying
      //       quote is brand-tier; this quote is product/comment-tier. It also
      //       buys nothing: a count with rating:null still fails
      //       INTENTS.social_proof_led.eligible (whose core IS the rating), so
      //       it would print a brand volume claim beside a product testimonial
      //       while still collapsing the intent. Stars-only is both safer and
      //       the only shape that actually fixes the reported bug.
      const exBrandCount = brandPair ? normalizeReviewCount(brandPair.reviewCount) : null;
      if (allowLabeledBrandNumbers === true && exBrandCount != null) {
        const exPair = resolveAtomicRatingPair({
          productRating: null,
          productReviewCount: null,
          brandRating: brandPair ? brandPair.rating : null,
          brandReviewCount: exBrandCount,
          brandAttribution,
          allowBrandCountWithoutStars: false,
          brandStarMin: brandStarFloorForCount(exBrandCount),
        });
        // Stars only. 'brand-count' is deliberately NOT accepted — see (c).
        if (exPair.source === 'brand' && exPair.rating) {
          return packCoherentProof({
            quote,
            quoteTier,
            rating: exPair.rating,
            reviewCount: exPair.reviewCount,
            source: 'brand',
            brandAttribution,
          });
        }
      }

      return emptyCoherentProof(quote, quoteTier);
    }

    if (side === 'brand') {
      // Brand/category quote → brand numbers ONLY. No product fallback.
      const brandRating = brandPair ? brandPair.rating : null;
      const brandReviewCount = brandPair ? brandPair.reviewCount : null;
      const brandStarMin = brandStarFloorForCount(brandReviewCount);

      const pair = resolveAtomicRatingPair({
        // Withhold product entirely.
        productRating: null,
        productReviewCount: null,
        brandRating,
        brandReviewCount,
        brandAttribution,
        // Coherent brand-side quote on frame → count-only is allowed.
        allowBrandCountWithoutStars: true,
        brandStarMin,
      });

      if (pair.source === 'brand' || pair.source === 'brand-count') {
        return packCoherentProof({
          quote,
          quoteTier,
          rating: pair.rating,
          reviewCount: pair.reviewCount,
          source: pair.source,
          brandAttribution,
        });
      }
      return emptyCoherentProof(quote, quoteTier);
    }

    // Unknown / unstamped tier with a printing quote → numbers withheld.
    return emptyCoherentProof(quote, quoteTier);
  }

  // ── No quote on frame: rating-only social proof ────────────────────
  // Product pair first (with volume exception), then brand stars.
  // product-count and brand-count both require a coherent quote — not here.
  const productRating = productPair ? productPair.rating : null;
  const productReviewCount = productPair ? productPair.reviewCount : null;
  const brandRating = brandPair ? brandPair.rating : null;
  const brandReviewCount = brandPair ? brandPair.reviewCount : null;

  const pair = resolveAtomicRatingPair({
    productRating,
    productReviewCount,
    brandRating,
    brandReviewCount,
    brandAttribution,
    allowBrandCountWithoutStars: false,
    productStarMin: productStarFloorForCount(productReviewCount),
    brandStarMin: brandStarFloorForCount(brandReviewCount),
  });

  if (pair.source === 'product' || pair.source === 'brand') {
    return packCoherentProof({
      quote: null,
      quoteTier: null,
      rating: pair.rating,
      reviewCount: pair.reviewCount,
      source: pair.source,
      brandAttribution: pair.source === 'brand' ? brandAttribution : null,
    });
  }

  return emptyCoherentProof(null, null);
}

module.exports = {
  RATING_STAR_MIN,
  RATING_STAR_VOLUME_MIN,
  RATING_STAR_VOLUME_COUNT_MIN,
  BRAND_VOLUME_EXCEPTION_ENABLED,
  QUOTE_TIER_NUMBER_SIDE,
  formatDisplayRating,
  normalizeReviewCount,
  brandAttributionLabel,
  formatCompactCount,
  resolveAtomicRatingPair,
  resolveCoherentSocialProof,
  // Exported for the Director proof menu (aiCreativeDirectorService.js):
  // a review COUNT is a fact independent of star quality, so a consumer that
  // is not rendering the star-graphic pair (i.e. not subject to the "only
  // show stars over the floor" rule) needs to name a count's scope WITHOUT
  // going through resolveAtomicRatingPair's star-floor gate, which otherwise
  // nulls the entire disclosure — count included — whenever the rating alone
  // fails the bar.
  formatBrandReviewsText,
  formatProductReviewsText,
};
