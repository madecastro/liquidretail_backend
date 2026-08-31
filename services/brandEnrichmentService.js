// Brand enrichment from a user-supplied website URL. Fetches the homepage,
// strips it to readable text + a few critical meta tags, asks GPT-4.1 via
// structured output for:
//   - tagline          (the brand's own positioning line)
//   - tone[]           (voice descriptors: "rugged, practical, technical")
//   - demographics[]   (key target personas — names + one-liners + interests
//                       + pain points + tone hints, used downstream by the
//                       layout generator to author notional persona quotes)
//   - color guesses    (best-effort from meta theme-color, else vibe-based)
//
// Logo discovery is deterministic and source-ranked: current storefront
// structured data/header assets/rendered DOM → Brandfetch → favicon fallback.
// The selected website asset is mirrored to Cloudinary during ingest.
//
// Fire-and-forget from brandCatalogService — the detect pipeline never
// awaits this. On failure the Brand stays a stub and gets another chance
// next time its website URL shows up on a new media upload.

const axios = require('axios');

const Brand = require('../models/Brand');
const { lookupBrand: brandfetchLookup } = require('./brandfetchService');
const { lookupBrandReviews } = require('./providers/geminiSearchProvider');
const {
  websiteBackgroundHex,
  normalizeWebsiteBackgroundHex
} = require('../utils/websiteBackground');

const { chatCompletion, isConfigured: atlasLlmConfigured } = require('./atlasLlmService');
const { inspectTailwindTheme } = require('./tailwindTokenExtractor');
const { metaAdsFontsEnabled } = require('./metaAdsFontService');
const MAX_HTML_CHARS = 25000;

const ENRICHMENT_SCHEMA = {
  type: 'object',
  properties: {
    tagline:        { type: 'string' },
    summary:        { type: 'string' },
    tone:           { type: 'array', items: { type: 'string' } },
    hashtags:       { type: 'array', items: { type: 'string' } },
    tags:           { type: 'array', items: { type: 'string' } },
    primaryColor:   { type: 'string' },
    secondaryColor: { type: 'string' },
    accentColor:    { type: 'string' },
    fontColor:      { type: 'string' },
    fontSuggestion: { type: 'string' },
    demographics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:        { type: 'string' },
          description: { type: 'string' },
          interests:   { type: 'array', items: { type: 'string' } },
          painPoints:  { type: 'array', items: { type: 'string' } },
          toneHint:    { type: 'string' }
        },
        required: ['name', 'description']
      }
    }
  },
  required: ['demographics']
};

// Atomic stage transition — independent of the in-memory `brand` doc
// the function is mutating, so it works even before/around the final
// brand.save() call. Failure is non-fatal (we never want enrichment
// progress reporting to crash enrichment itself).
async function setStage(brandId, stage) {
  try {
    await Brand.updateOne({ _id: brandId }, { $set: { enrichmentStage: stage } });
  } catch (e) {
    console.warn(`   ⚠️  enrichmentStage write failed for ${brandId}: ${e.message}`);
  }
}

// Persist WHY enrichment declined to run. Before this, every early-return
// below was a genuinely silent no-op: the {ok:false, reason} object was
// discarded by every fire-and-forget caller (brandCatalogService,
// apifyIngestService, the various triggerEnrichment helpers all
// `.catch(...)` and drop the resolved value), so a brand missing a
// websiteUrl could sit forever with a fully-synced catalog and nothing
// anywhere recording that enrichment had ever even been attempted. Never
// throws — a failure to record the reason must not turn a graceful skip
// into an unhandled rejection for a fire-and-forget caller.
async function markEnrichmentSkipped(brandId, reason) {
  try {
    await Brand.updateOne(
      { _id: brandId },
      { $set: { enrichmentSkipReason: reason, enrichmentSkippedAt: new Date() } }
    );
  } catch (e) {
    console.warn(`   ⚠️  enrichmentSkipReason write failed for ${brandId}: ${e.message}`);
  }
}

// Clear a stale skip reason once we're actually proceeding — otherwise a
// brand that gets its websiteUrl back-filled (see brandWebsiteBackfill.js)
// and then successfully enriches would still show a "no websiteUrl" skip
// reason from before the fix, which is worse than no field at all.
async function clearEnrichmentSkipped(brandId) {
  try {
    await Brand.updateOne(
      { _id: brandId },
      { $set: { enrichmentSkipReason: null, enrichmentSkippedAt: null } }
    );
  } catch (e) {
    console.warn(`   ⚠️  enrichmentSkipReason clear failed for ${brandId}: ${e.message}`);
  }
}

async function enrichBrandFromUrl(brandId) {
  const brand = await Brand.findById(brandId);
  if (!brand) return { ok: false, reason: 'brand not found' };
  if (!brand.websiteUrl) {
    await markEnrichmentSkipped(brandId, 'no websiteUrl');
    return { ok: false, reason: 'no websiteUrl' };
  }
  // We're proceeding — any previously-recorded skip no longer describes
  // current reality. Clear before the run starts so a crash mid-run still
  // leaves the doc in a truthful "attempted, not skipped" state (a thrown
  // error is visible via run.fail() / CampaignRun-style plumbing, not via
  // this field — this field is specifically for "declined to even try").
  await clearEnrichmentSkipped(brandId);

  // Belt-and-suspenders: clear stage at the end of EVERY exit path
  // (success, early return, thrown error). The final brand.save() also
  // writes null because the in-memory `brand.enrichmentStage` is
  // never mutated, but the explicit clear covers thrown errors.
  const { startRun, CancelledError } = require('./progressService');
  const run = await startRun({ kind: 'enrichment', advertiserId: brand.advertiserId, brandId, label: 'Brand enrichment' });
  try {
    const result = await runEnrichment(brand, brandId, run);
    await run.succeed(result && typeof result === 'object' ? { ok: result.ok !== false } : undefined);
    return result;
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log(`🧠 enrichment cancelled by operator: brand=${brandId}`);
      return { ok: false, cancelled: true, reason: 'cancelled by operator' };
    }
    await run.fail(err);
    throw err;
  } finally {
    await setStage(brandId, null);
  }
}

/**
 * preserveBrandReviewNumbers(fresh, prior) — mutates `fresh` in place, returns it.
 *
 * FRESH QUOTES, BUT NEVER DOWNGRADE THE NUMBERS.
 *
 * The persist predicate at the call site was widened so a numbers-only result still
 * saves. The assignment stayed a WHOLESALE REPLACE, which leaves the mirror-image
 * hole: a result with good quotes but `rating: null` wipes a previously-good rating.
 * Observed live — Pelagic Gear held 3.2★ / 22 reviews, one refresh returned 2 quotes
 * with null rating AND null reviewCount, and the brand came back with no numbers at
 * all.
 *
 * CORRECTED 2026-08-11: this comment first blamed grounded-search drift, on the grounds
 * that a run which looked pre-deploy also came back without numbers. That was WRONG —
 * the deploy live at 09:05 already contained the retrieval rewrite, so every
 * number-less run was on the new prompt. The real cause was pass-1 truncation
 * (`finishReason: MAX_TOKENS`, with the rating asked for LAST), fixed in
 * geminiSearchProvider — see NARRATIVE_ORDER_NOTE there. Kept as a note because the
 * lesson generalises: "the upstream fetch returned nothing" is a claim to check against
 * a deploy timeline, not one to assume.
 *
 * THIS FUNCTION IS STILL REQUIRED. A fetch can legitimately find no aggregates, and
 * when it does, destroying the stored ones is our bug, not the web's.
 *
 * Why it matters beyond a cosmetic card: `INTENTS.social_proof_led`'s `core` IS the
 * rating, so a wiped rating removes a brand's ability to render social-proof ads —
 * the exact failure this workstream just fixed. (Pelagic's own 3.2 sits under
 * RATING_STAR_MIN 4.39 and never printed stars, so THAT brand lost stored data
 * rather than a live ad format; the eligibility loss is what the same wipe does to
 * any brand at or above the floor.)
 *
 * THE PAIR IS ONE ATOM — the part that is easy to get wrong. A per-field carry
 * silently manufactures a cross-snapshot pair: prior `{3.2, 22}` + fresh
 * `{null, 6000}` would store `{4.3, 6000}`-shaped data whose rating was measured on
 * a different, far smaller sample. That is not academic: `brandStarFloorForCount`
 * (ratingDisplay.js) LOWERS the star floor from 4.39 to 4.19 once the count clears
 * 5000, so a stale rating paired with a fresh high count can print stars that the
 * real snapshot never earned. `resolveAtomicRatingPair` exists to stop exactly this,
 * and a merge here must not defeat it. So rating and reviewCount are carried
 * TOGETHER, and only when the fresh fetch supplies neither.
 *
 * `summary` is carried on its own because it is prose about the reviews, not a term
 * in the pair — it is never typeset as a customer quote and no display gate keys a
 * number off it.
 *
 * QUOTES ARE STILL REPLACED WHOLESALE, ON PURPOSE: a refresh SHOULD adopt the
 * newly-filtered pool, and carrying stale quotes forward would defeat the retrieval
 * change. A fresh number always wins over a stored one, INCLUDING when it is lower —
 * this preserves data, it does not flatter it.
 *
 * `numbersFetchedAt` records when the numbers now stored were actually measured,
 * which `fetchedAt` cannot: that stamps the quote fetch. Nothing reads it yet; it
 * exists so a carried aggregate is not indistinguishable from a fresh one. (Known
 * follow-up: `productMatchService`'s 30-day TTL keys off `fetchedAt`, so carried
 * numbers can ride along un-refetched. Bounding that needs an owner call on how
 * stale an aggregate may get.)
 *
 * Exported so the harness exercises the shipped function instead of a copy.
 */
function preserveBrandReviewNumbers(fresh, prior) {
  if (!fresh || typeof fresh !== 'object') return fresh;
  if (!prior || typeof prior !== 'object') return fresh;
  // `typeof NaN === 'number'`, and a NaN rating would survive every naive check and
  // then compare false against every star floor. Only finite numbers count as data.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const freshRating = num(fresh.rating);
  const freshCount  = num(fresh.reviewCount);
  const priorRating = num(prior.rating);
  const priorCount  = num(prior.reviewCount);

  if (freshRating == null && freshCount == null && (priorRating != null || priorCount != null)) {
    fresh.rating      = priorRating;
    fresh.reviewCount = priorCount;
    fresh.numbersFetchedAt = prior.numbersFetchedAt || prior.fetchedAt || null;
    const countBit = priorCount != null ? ` / ${priorCount} reviews` : '';
    console.log(`   · brand-reviews: fetch returned no numbers — preserving stored ${priorRating != null ? `${priorRating}★` : 'count'}${countBit}`);
  } else {
    // At least one fresh number: keep the fresh snapshot EXACTLY as measured, half
    // of it null if that is what came back. Filling the gap from `prior` is the
    // cross-snapshot pair this function exists to prevent.
    fresh.rating      = freshRating;
    fresh.reviewCount = freshCount;
    fresh.numbersFetchedAt = (freshRating != null || freshCount != null)
      ? (fresh.fetchedAt || new Date())
      : (fresh.numbersFetchedAt || null);
  }

  if (fresh.summary == null || fresh.summary === '') {
    fresh.summary = (prior.summary == null || prior.summary === '') ? null : prior.summary;
  }
  return fresh;
}

async function runEnrichment(brand, brandId, run = null) {

  // Per-field protection (curatedFields) replaces the old wholesale
  // 'curated' / 'enriched' bail-outs. We re-run enrichment whenever an
  // auto-source is missing from the attempted list — Brandfetch is the
  // most common gap (e.g. older brands enriched before the API key was
  // configured) and it's the highest-quality source so we want to
  // backfill it whenever we can.
  const sourcesAttempted = new Set(brand.enrichmentSources || []);
  const wantBrandfetch   = !!process.env.BRANDFETCH_API_KEY && !sourcesAttempted.has('brandfetch');
  const wantTailwind     = !sourcesAttempted.has('tailwind');
  const wantScraped      = !sourcesAttempted.has('scraped');
  /**
   * ATLAS IS THE PRIMARY, OPENAI IS ONLY THE FALLBACK — so gate on either.
   *
   * This tier's call goes through `atlasLlmService.chatCompletion` (see the
   * import above), whose primary is Atlas (`ATLAS_API_KEY`) with direct
   * providers kept only as a fallback per operator directive. Gating the tier
   * on `OPENAI_API_KEY` alone meant that after the move to Atlas, a deployment
   * holding only Atlas credentials **silently skipped the entire GPT
   * enrichment tier** — a precondition checking a key the call no longer
   * needs. That tier owns most of the derived brand attributes:
   * `ENRICHMENT_SCHEMA` (:33) writes tagline, summary, tone, hashtags, tags,
   * demographics, the colours and fontSuggestion. `summary` in particular has
   * NO other automated writer (`setIf('summary', …, 'gpt')`), so it stayed
   * empty for every non-curated brand — and `brand_signal.description` in the
   * Director brief reads exactly that field.
   *
   * NOT the same as `wantBrandReviews` below: `geminiSearchProvider` calls
   * Google's grounded-search endpoint DIRECTLY with `GEMINI_API_KEY` and is
   * deliberately not behind `atlasLlmService` (Atlas does not proxy grounded
   * retrieval), so gating that tier on its own key is correct.
   */
  const wantGpt          = (atlasLlmConfigured() || !!process.env.OPENAI_API_KEY)
                             && !sourcesAttempted.has('gpt');
  const wantBrandReviews = !!process.env.GEMINI_API_KEY && !sourcesAttempted.has('brand-reviews');
  const wantFontIngest   = !brand.fontIngestedAt;
  // Second font source, for the common premium-DTC case where the website
  // scan cannot get the file (foundry CDN 403, or a JS-injected stack with no
  // @font-face in the fetched HTML). Gated on its own stamp so the billable
  // vision call is paid at most once per brand.
  const wantMetaFonts    = metaAdsFontsEnabled() && !brand.metaFontsIngestedAt;
  // Shopify theme font scan (added 2026-08-31) — a THIRD, independent font
  // source alongside the website scan above and the meta-ads vision scan
  // below. Gated purely on "does this brand have a Shopify URL configured"
  // (the same apifyDemo.shopifyUrl field resolveStoreOrigin reads), NOT on
  // Brand.apifyDemo.method or Brand.isDemo — owner directive: this must run
  // for any brand with a Shopify connection regardless of which catalog-
  // ingest method (if any) that brand uses. Own retry stamp
  // (shopifyFontsIngestedAt), independent of fontIngestedAt — see
  // brandFontPersistenceService.applyShopifyFontIngestResult's header.
  const wantShopifyFonts = !!(brand.apifyDemo?.shopifyUrl) && !brand.shopifyFontsIngestedAt;
  const logoIsCurated    = Array.isArray(brand.curatedFields) && brand.curatedFields.includes('logoUrl');
  const wantLogoIngest   = !logoIsCurated && !brand.logoIngestedAt;

  if (!wantBrandfetch && !wantTailwind && !wantScraped && !wantGpt && !wantBrandReviews && !wantFontIngest && !wantLogoIngest && !wantMetaFonts && !wantShopifyFonts) {
    return { ok: false, reason: `nothing to add — sources already attempted: ${[...sourcesAttempted].join(', ') || 'none'}` };
  }

  const t0 = Date.now();
  const planParts = [];
  if (wantBrandfetch)   planParts.push('brandfetch');
  if (wantTailwind)     planParts.push('tailwind');
  if (wantScraped)      planParts.push('scrape');
  if (wantGpt)          planParts.push('gpt');
  if (wantBrandReviews) planParts.push('brand-reviews');
  if (wantFontIngest)   planParts.push('website-fonts');
  if (wantLogoIngest)   planParts.push('website-logo');
  if (wantMetaFonts)    planParts.push('meta-ads-fonts');
  if (wantShopifyFonts) planParts.push('shopify-theme-fonts');
  console.log(`🌐 brand enrichment: ${brand.websiteUrl} for "${brand.name}" — running ${planParts.join('+')}${sourcesAttempted.size ? ` (already have: ${[...sourcesAttempted].join(', ')})` : ''}`);

  // ── Tier 1: Brandfetch ──
  // Hits the brand kit API for native logo + colors + fonts. Skipped
  // if no API key OR if already attempted on a previous run.
  const hostname = hostnameFromUrl(brand.websiteUrl);
  if (run) { await run.checkpoint(); run.stage('brandfetch'); }
  if (wantBrandfetch && hostname) await setStage(brandId, 'brandfetch');
  const bf = (wantBrandfetch && hostname) ? await brandfetchLookup(hostname) : null;
  if (wantBrandfetch && bf) {
    const filled = [];
    for (const k of ['logoUrl', 'primaryColor', 'secondaryColor', 'accentColor', 'fontFamily']) {
      if (bf[k]) filled.push(`${k}=${bf[k].length > 50 ? bf[k].slice(0, 47) + '…' : bf[k]}`);
    }
    console.log(`   · brandfetch returned: ${filled.join(', ') || '(empty)'}`);
  }

  // ── Tier 2: Homepage HTML ──
  if (run && wantScraped) { await run.checkpoint(); run.stage('website scrape'); }
  if (wantScraped) await setStage(brandId, 'scraped');
  let html = '';
  let pageUrl = brand.websiteUrl;
  let metaThemeColor = null;
  try {
    const res = await axios.get(brand.websiteUrl, {
      timeout: 20000,
      maxContentLength: 4 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LiquidRetailBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      validateStatus: () => true
    });
    html = typeof res.data === 'string' ? res.data : String(res.data || '');
    pageUrl = res.request?.res?.responseUrl || brand.websiteUrl;
    const themeMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
    if (themeMatch) metaThemeColor = themeMatch[1];
  } catch (err) {
    console.warn(`   ⚠️  brand enrichment fetch failed for ${brand.websiteUrl}: ${err.message}`);
    // If Brandfetch already gave us the visual identity, the GPT step still
    // adds value (tagline/tone/personas need text). Without HTML we can't
    // do GPT so we have to bail unless Brandfetch gave us enough.
    if (!bf && !wantLogoIngest) return { ok: false, reason: `fetch failed: ${err.message}` };
  }

  // Tier 2 helpers — run on whatever HTML we got (may be empty).
  const scrapedFontFamily  = extractGoogleFontsFamily(html);
  let websiteLogo = null;
  if (wantLogoIngest) {
    if (run) { await run.checkpoint(); run.stage('website logo'); }
    await setStage(brandId, 'website-logo');
    try {
      const { discoverAndIngestBrandLogo } = require('./brandLogoIngestService');
      websiteLogo = await discoverAndIngestBrandLogo(brand, { html: html || null, pageUrl });
      brand.logoIngestedAt = new Date();
      brand.logoIngestError = null;
      if (websiteLogo.logoUrl) {
        brand.logoOriginalUrl = websiteLogo.originalUrl;
        console.log(
          `   · website logo: ${websiteLogo.source}, ${websiteLogo.width || '?'}×${websiteLogo.height || '?'}, ` +
          `${websiteLogo.candidatesChecked} candidate(s)`
        );
      } else {
        console.log(`   · website logo: no validated mark from ${websiteLogo.candidatesChecked} candidate(s)`);
      }
    } catch (err) {
      brand.logoIngestedAt = new Date();
      brand.logoIngestError = String(err.message || err).slice(0, 2000);
      console.warn(`   ⚠️  website logo ingest failed for "${brand.name}": ${err.message}`);
    }
  }
  // FLAG: static-HTML/CSS heuristic for page surface color (NOT theme-color).
  // headlessScrapeService is product-ingest + SHOPIFY_HEADLESS_RENDER-gated —
  // too heavy to couple into every brand enrichment just for body bg.
  // Heuristic: body/html inline style → body{...} rules inside <style> tags.
  // Linked stylesheets are NOT fetched here (not "already fetched"); returns null
  // rather than guessing a dark color from meta theme-color.
  const scrapedWebsiteBackground = extractWebsiteBackground(html);
  // Tailwind is extracted from published CSS/config only; no third-party JS
  // is evaluated. A high-confidence result takes precedence over every other
  // automatic enrichment source, never over a human-curated field.
  let tailwind = null;
  if (wantTailwind && html) {
    if (run) { await run.checkpoint(); run.stage('tailwind tokens'); }
    await setStage(brandId, 'tailwind');
    tailwind = await inspectTailwindTheme({ html, pageUrl: brand.websiteUrl });
    if (tailwind) console.log(`   · tailwind tokens: ${Object.keys(tailwind.colors || {}).length} color(s), ${Object.keys(tailwind.fonts || {}).length} font role(s), source=${tailwind.source}`);
  }

  const rawTextContent = extractTextFromHtml(html).slice(0, MAX_HTML_CHARS);
  // JS-rendered SPAs (Next.js, Shopify Hydrogen, etc.) leave almost
  // nothing readable in the initial HTML. If Brandfetch gave us a
  // description we use that as substitute context so GPT can still
  // produce tagline/summary/tone/personas/hashtags/tags/fontSuggestion.
  const htmlTooShort = rawTextContent.length < 200;
  const bfDescription = [bf?.description, bf?.longDescription].filter(Boolean).join('\n\n');
  const usingBfFallback = htmlTooShort && bfDescription.length >= 80;
  const textContent = usingBfFallback ? bfDescription : rawTextContent;
  const sourceLabel = usingBfFallback ? 'Brandfetch description (homepage HTML was JS-rendered)' : 'the homepage (HTML stripped)';

  if (usingBfFallback) {
    console.log(`   · GPT input swap: HTML scrape too short (${rawTextContent.length} chars) — using Brandfetch description (${bfDescription.length} chars) as context`);
  }

  // Without usable text AND without Brandfetch data, there's nothing to ship.
  const skipLLM = textContent.length < 200;
  if (skipLLM && !bf) {
    console.warn(`   ⚠️  brand enrichment: ${brand.websiteUrl} returned too little text (${rawTextContent.length} chars) — likely bot-blocked, no Brandfetch fallback`);
    // Font stylesheets may still be public even when readable page text is
    // sparse (Shopify/Next storefronts), so continue when the automatic
    // website-font scan has not run yet.
    if (!wantFontIngest && !wantLogoIngest) return { ok: false, reason: 'too little text and no Brandfetch data' };
  }

  // ── Tier 3: GPT-4.1 text extraction ──
  // Skipped when we have no usable text (bot-blocked, no Brandfetch
  // description) OR when GPT was already attempted on a previous run.
  // Brandfetch alone can ship partial enrichment without GPT.
  let enrichment = {};
  if (!skipLLM && wantGpt) {
    if (run) { await run.checkpoint(); run.stage('gpt derivation'); }
    await setStage(brandId, 'gpt');
    const prompt =
      `You are analyzing "${brand.name}" (${brand.websiteUrl}) to fill a brand catalog entry.\n\n` +
      `Source text from ${sourceLabel}:\n"""\n${textContent}\n"""\n\n` +
      `Return JSON matching the schema. Rules:\n` +
      `- "tagline": one line (≤ 12 words), the brand's own positioning if visible on the page; omit if you can't find it.\n` +
      `- "summary": 2–4 sentences describing who the brand is, what they make, who they serve, and what makes them distinct. Written for someone who has never heard of them. Avoid marketing fluff — concrete and specific.\n` +
      `- "tone": 2–5 single-word descriptors of the brand's voice (e.g. ["rugged","practical","technical"]).\n` +
      `- "hashtags": 5–10 hashtags this brand commonly uses on social, INCLUDING the # symbol (e.g. ["#pelagic","#offshore","#anglerlife"]). Pull from observed campaigns, common community tags, or the brand's category vernacular. Omit only if the brand has no plausible social presence.\n` +
      `- "tags": 5–10 lowercase keyword tags WITHOUT the # symbol — short search/category descriptors of what this brand sells or stands for (e.g. ["fishing","performance","apparel","outdoor","sun-protection"]). Concrete and indexable.\n` +
      `- "primaryColor" / "secondaryColor" / "accentColor": 6-digit hex strings (e.g. "#0a2540"). Use meta theme-color or visible brand colors when detectable; otherwise best-guess from positioning/category. Omit if truly no signal.\n` +
      `- "fontColor": 6-digit hex string for the brand's body-text color (the color they use for headlines and paragraph copy on their own site). Typically near-black for light-themed brands ("#111111" / "#1a1a1a") or near-white for dark-themed ones ("#f5f5f5"). Omit if truly indeterminable.\n` +
      `- "fontSuggestion": ONE Google Fonts family name that fits this brand's personality based on its tone, summary, and category. Must be a REAL Google Fonts family — pick from common, well-supported choices. Examples by feel:\n` +
      `    rugged/outdoors  → "Bebas Neue", "Oswald", "Anton"\n` +
      `    premium/editorial → "Playfair Display", "Lora", "Cormorant Garamond"\n` +
      `    technical/modern  → "Inter", "DM Sans", "IBM Plex Sans"\n` +
      `    playful/friendly  → "Poppins", "Nunito", "Quicksand"\n` +
      `    minimal/clean     → "Manrope", "DM Sans", "Work Sans"\n` +
      `  This is a SUGGESTION used only when the brand's actual font isn't detectable — pick the single best fit.\n` +
      `- "demographics": 3–5 key target customer personas this brand clearly serves. Each persona:\n` +
      `    • "name": short, memorable (e.g. "Saltwater Joe", "Weekend Warrior", "Urban Professional")\n` +
      `    • "description": one sentence (≤ 20 words) describing who they are\n` +
      `    • "interests": 3–5 one-word or short-phrase interests\n` +
      `    • "painPoints": 2–4 short phrases describing what they worry about that this brand solves\n` +
      `    • "toneHint": one sentence describing how this persona talks (informs notional quote generation)\n` +
      `Ground personas in the brand's actual positioning; don't invent irrelevant personas. If the brand is niche, 2 personas is fine.`;

    try {
      const response = await chatCompletion({ stage: 'brand_enrichment_gpt', service: 'brandEnrichmentService', brandId: brandId || null }, {
        model: 'gpt-4.1',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.3
      });
      enrichment = JSON.parse(response.choices[0].message.content);
    } catch (err) {
      console.warn(`   ⚠️  brand enrichment LLM failed for "${brand.name}": ${err.message}`);
      // If LLM fails but Brandfetch worked, still ship the visual identity.
      if (!bf && !websiteLogo?.logoUrl && !wantFontIngest && !wantLogoIngest) {
        return { ok: false, reason: `LLM failed: ${err.message}` };
      }
    }
  }

  // ── Merge — priority: Brandfetch > HTML scrape > meta theme-color > GPT > existing ──
  // Per-field curation lock: any field listed in brand.curatedFields was
  // explicitly set by a human and is protected from auto-overwrite.
  // Brandfetch values OVERRIDE existing ones (highest reliability source);
  // they remain blocked only by curatedFields.
  const isCurated = (k) => Array.isArray(brand.curatedFields) && brand.curatedFields.includes(k);
  const overrides = []; // [{ field, oldVal, newVal, source }] — for logging
  const setIf = (k, v, source) => {
    if (isCurated(k)) return;
    if (v == null || v === brand[k]) return;
    overrides.push({ field: k, oldVal: brand[k], newVal: v, source });
    brand[k] = v;
  };

  // Walk priority chain per field; remember which source actually wins
  // so the log line can attribute correctly.
  const pick = (...cands) => {
    for (const [val, src] of cands) if (val != null) return [val, src];
    return [null, null];
  };

  let [logoVal, logoSrc] = pick(
    [websiteLogo?.logoUrl, websiteLogo?.source ? `website:${websiteLogo.source}` : 'website'],
    [bf?.logoUrl, 'brandfetch'],
    [brand.logoUrl, 'existing'],
    [googleFaviconFallback(hostname), 'google-favicon']
  );
  setIf('logoUrl', logoVal, logoSrc);
  if (!isCurated('logoUrl') && logoSrc && logoSrc !== 'existing') {
    brand.logoSource = logoSrc;
    if (!logoSrc.startsWith('website:')) brand.logoOriginalUrl = logoVal;
  }

  // Font resolution chain. High-confidence sources first
  // (Brandfetch / scraped Google Fonts), then GPT-suggested based on
  // brand personality, then a tone-based hardcoded safety net so
  // every brand gets a usable font instead of system-ui defaults.
  // Tracked on brand.fontSource so the UI can mark approximated
  // fonts as "(suggested)".
  const toneDefault = toneToDefaultFont(enrichment.tone || brand.tone);
  // Brandfetch occasionally returns a CSS variable reference instead of
  // a real font name — reject those so we fall through to a usable tier.
  const bfFont = isValidFontName(bf?.fontFamily) ? bf.fontFamily : null;
  if (bf?.fontFamily && !bfFont) {
    console.log(`   · brandfetch font rejected (not a real family name): ${bf.fontFamily}`);
  }
  let [fontVal, fontSrc] = pick(
    [tailwind?.fonts?.heading || tailwind?.fonts?.body, 'tailwind'],
    [bfFont, 'brandfetch'],
    [isValidFontName(scrapedFontFamily) ? scrapedFontFamily : null, 'scraped'],
    [isValidFontName(enrichment.fontSuggestion) ? enrichment.fontSuggestion : null, 'suggested'],
    [toneDefault, 'tone-default'],
    [brand.fontFamily, 'existing']
  );
  setIf('fontFamily', fontVal, fontSrc);
  // Persist the source label on the brand so /api/brand returns it
  // and the Brand Object tab can show "(suggested)" / "(scraped)".
  // Don't overwrite a curated-source label.
  if (brand.fontSource !== 'curated' && fontSrc && fontSrc !== 'existing') {
    brand.fontSource = fontSrc;
  }

  let [primaryVal, primarySrc] = pick(
    [tailwind?.colors?.primary, 'tailwind'],
    [bf?.primaryColor, 'brandfetch'],
    [metaThemeColor, 'meta-theme-color'],
    [enrichment.primaryColor, 'gpt'],
    [brand.primaryColor, 'existing']
  );
  setIf('primaryColor', primaryVal, primarySrc);

  let [secondaryVal, secondarySrc] = pick(
    [tailwind?.colors?.secondary, 'tailwind'],
    [bf?.secondaryColor, 'brandfetch'],
    [enrichment.secondaryColor, 'gpt'],
    [brand.secondaryColor, 'existing']
  );
  setIf('secondaryColor', secondaryVal, secondarySrc);

  let [accentVal, accentSrc] = pick(
    [tailwind?.colors?.accent, 'tailwind'],
    [bf?.accentColor, 'brandfetch'],
    [enrichment.accentColor, 'gpt'],
    [brand.accentColor, 'existing']
  );
  setIf('accentColor', accentVal, accentSrc);

  let [fontColorVal, fontColorSrc] = pick(
    [tailwind?.colors?.font, 'tailwind'],
    [bf?.fontColor, 'brandfetch'],
    [enrichment.fontColor, 'gpt'],
    [brand.fontColor, 'existing']
  );
  setIf('fontColor', fontColorVal, fontColorSrc);

  // Surface background for transparent product flatten (Cloudinary b_rgb).
  // Scraped only — never theme-color, never GPT guess (dark accents would
  // reintroduce product-on-black). Respects curatedFields via setIf.
  let [websiteBgVal, websiteBgSrc] = pick(
    [tailwind?.colors?.background, 'tailwind'],
    [scrapedWebsiteBackground, 'scraped'],
    [normalizeWebsiteBackgroundHex(brand.websiteBackground), 'existing']
  );
  setIf('websiteBackground', websiteBgVal, websiteBgSrc);

  if (tailwind && !isCurated('tailwindTheme')) {
    const previousTailwind = brand.tailwindTheme;
    brand.tailwindTheme = tailwind;
    overrides.push({ field: 'tailwindTheme', oldVal: previousTailwind ? '(previous)' : null, newVal: `${tailwind.source}/${tailwind.confidence}`, source: 'tailwind' });
  }

  let [taglineVal, taglineSrc] = pick(
    [enrichment.tagline, 'gpt'],
    [bf?.description, 'brandfetch'],
    [brand.tagline, 'existing']
  );
  setIf('tagline', taglineVal, taglineSrc);

  if (!isCurated('tone') && Array.isArray(enrichment.tone) && enrichment.tone.length) {
    overrides.push({ field: 'tone', oldVal: brand.tone, newVal: enrichment.tone, source: 'gpt' });
    brand.tone = enrichment.tone;
  }

  // Verbose brand summary — paragraph-style. setIf prefers truthy
  // values so it won't blow away existing text with an empty string.
  setIf('summary', enrichment.summary || null, 'gpt');

  // Hashtags + tags. We dedupe + cap. Hashtags get a leading # if
  // GPT forgot it; tags are normalized to lowercase no-#.
  if (!isCurated('hashtags') && Array.isArray(enrichment.hashtags) && enrichment.hashtags.length) {
    const cleaned = dedupe(
      enrichment.hashtags
        .map(h => String(h).trim())
        .filter(Boolean)
        .map(h => h.startsWith('#') ? h : `#${h.replace(/^#+/, '')}`)
    ).slice(0, 12);
    overrides.push({ field: 'hashtags', oldVal: brand.hashtags, newVal: cleaned, source: 'gpt' });
    brand.hashtags = cleaned;
  }
  if (!isCurated('tags') && Array.isArray(enrichment.tags) && enrichment.tags.length) {
    const cleaned = dedupe(
      enrichment.tags
        .map(t => String(t).trim().toLowerCase().replace(/^#+/, ''))
        .filter(Boolean)
    ).slice(0, 12);
    overrides.push({ field: 'tags', oldVal: brand.tags, newVal: cleaned, source: 'gpt' });
    brand.tags = cleaned;
  }
  if (!isCurated('demographics') && Array.isArray(enrichment.demographics) && enrichment.demographics.length) {
    brand.demographics = enrichment.demographics.slice(0, 6).map(d => ({
      name:        d.name,
      description: d.description || '',
      interests:   Array.isArray(d.interests)  ? d.interests.slice(0, 6)  : [],
      painPoints:  Array.isArray(d.painPoints) ? d.painPoints.slice(0, 4) : [],
      toneHint:    d.toneHint || ''
    }));
  }

  // ── Tier 4: Brand reviews (Gemini grounded search) ──
  // Caches brand-level review snapshot on the Brand catalog so per-
  // Media brand_match outcomes share one fetch instead of re-querying
  // Gemini every detect run. Skipped when curation has explicitly
  // marked the field protected.
  let brandReviewsResult = null;
  if (wantBrandReviews && !isCurated('brandReviews')) {
    if (run) { await run.checkpoint(); run.stage('brand reviews'); }
    await setStage(brandId, 'brand-reviews');
    try {
      brandReviewsResult = await lookupBrandReviews({
        brandName: brand.name,
        brandUrl:  brand.websiteUrl,
        brandId                       // cost-ledger linkage (CostLog.brandId)
      });
      // PERSIST ON QUOTES **OR** NUMBERS. The old predicate was
      // `quotes.length` alone, which threw the WHOLE snapshot away when the
      // grounded search found a brand's star rating and review count but no
      // usable quote — and `geminiSearchProvider` returns `rating` /
      // `reviewCount` INDEPENDENTLY of `quotes` (:409-411), so that is a real
      // and common shape (quotes also thin out via stampLlmQuotes/provenance
      // while the numbers survive). The cost was permanent, not transient:
      // `wantBrandReviews` gates on `!sourcesAttempted.has('brand-reviews')`,
      // so the tier is marked attempted and NEVER retried — the brand keeps a
      // null `brandReviews` forever and `buildMetaForAd`'s brandSnapshot
      // (brandScriptExecutor.js:947) has nothing, so the ad ships with no
      // stars even though we successfully looked the numbers up.
      //
      // A rating + count is a numeric aggregate, NOT a testimonial, so this
      // widens only the numbers path — every quote provenance gate
      // (quoteProvenance / toPrintableCustomerQuote / gateLayoutInputQuotes)
      // is untouched and a quote-less snapshot simply yields a trust mark.
      // Verified safe against every consumer: all read `quotes` behind
      // `Array.isArray(...) ? ... : []` and read rating/count independently.
      const hasQuotes  = Array.isArray(brandReviewsResult?.quotes) && brandReviewsResult.quotes.length > 0;
      const hasNumbers = typeof brandReviewsResult?.rating === 'number'
                      || typeof brandReviewsResult?.reviewCount === 'number';
      if (brandReviewsResult && (hasQuotes || hasNumbers)) {
        brandReviewsResult.fetchedAt = new Date();
        preserveBrandReviewNumbers(brandReviewsResult, brand.brandReviews);
        brand.brandReviews = brandReviewsResult;
        const quoteBit  = hasQuotes ? `${brandReviewsResult.quotes.length} quote(s)` : 'no quotes';
        const ratingBit = typeof brandReviewsResult.rating === 'number'
          ? `, ${brandReviewsResult.rating.toFixed(1)}★` : '';
        const countBit  = typeof brandReviewsResult.reviewCount === 'number'
          ? ` (${brandReviewsResult.reviewCount} reviews)` : '';
        overrides.push({
          field: 'brandReviews',
          oldVal: '(none)',
          newVal: `${quoteBit}${ratingBit}${countBit}`,
          source: 'gemini-search'
        });
      }
    } catch (err) {
      console.warn(`   ⚠️  brand-reviews tier failed for "${brand.name}": ${err.message}`);
    }
  }

  // Track which sources we ATTEMPTED on this run so subsequent runs
  // know whether to backfill (e.g. Brandfetch came online later).
  const newSourcesAttempted = new Set(brand.enrichmentSources || []);
  if (wantBrandfetch)   newSourcesAttempted.add('brandfetch');
  if (wantTailwind)     newSourcesAttempted.add('tailwind');
  if (wantScraped)      newSourcesAttempted.add('scraped');
  if (wantGpt && !skipLLM) newSourcesAttempted.add('gpt');
  if (wantBrandReviews) newSourcesAttempted.add('brand-reviews');
  brand.enrichmentSources = [...newSourcesAttempted];

  brand.source = 'enriched';
  brand.enrichedAt = new Date();
  await brand.save();

  // Initial brand ingest now includes the customer's real website font
  // files. This remains best-effort: a blocked stylesheet or commercial
  // foundry must not fail the rest of brand enrichment.
  if (wantFontIngest && brand.websiteUrl) {
    if (run) { await run.checkpoint(); run.stage('website fonts'); }
    try {
      const { ingestBrandFonts } = require('./brandFontIngestService');
      const { applyFontIngestResult } = require('./brandFontPersistenceService');
      const fontResult = await ingestBrandFonts(brand, { trackProgress: false });
      applyFontIngestResult(brand, fontResult);
      await brand.save();
      console.log(
        `   · website fonts: ${fontResult.ingested.length} usable, ` +
        `${fontResult.flagged.length} flagged, heading=${fontResult.usage?.heading || 'unknown'}, ` +
        `body=${fontResult.usage?.body || 'unknown'}`
      );
    } catch (err) {
      // CORRECTED 2026-08-31 — this used to also set
      // `brand.fontIngestedAt = new Date()`, permanently disabling retry.
      // Unlike the meta-ads path below, this path is entirely FREE (a plain
      // HTTP fetch + CSS parse + font downloads — no billable call anywhere
      // in it), so there is no cost-avoidance reason to ever give up on it
      // for good. A transient 404/DNS blip/server hiccup fetching the
      // homepage must not turn into a lifetime ban on ever scanning that
      // brand's website fonts again. Measured: brand "Reach Social"
      // (https://reach-social.io) failed once with a plain
      // "Request failed with status code 404" and was stuck forever.
      // Record the error for visibility; leave fontIngestedAt untouched so
      // the next enrichment run retries for free.
      brand.fontIngestError = String(err.message || err).slice(0, 2000);
      await brand.save().catch(() => {});
      console.warn(`   ⚠️  website font ingest failed for "${brand.name}": ${err.message}`);
    }
  }

  // Fonts from the brand's Shopify THEME (added 2026-08-31) — a second real-
  // FILE source, independent of the marketing-homepage scan above. Runs
  // right after it (both yield files; neither is a weaker fallback for the
  // other) and before the meta-ads vision tier below (a NAME-only source
  // should never be tried ahead of a source that can hand back an actual
  // file). FREE (plain HTTP, or Admin API billed to the merchant's own
  // Shopify plan — see shopifyThemeFontService.js's header) — like the
  // website scan above, a failure must NEVER permanently disable retry, so
  // applyShopifyFontIngestResult (which stamps shopifyFontsIngestedAt) is
  // only called on success; the catch below records the error and nothing
  // else.
  if (wantShopifyFonts) {
    if (run) { await run.checkpoint(); run.stage('shopify theme fonts'); }
    try {
      const { ingestShopifyThemeFonts } = require('./shopifyThemeFontService');
      const { applyShopifyFontIngestResult } = require('./brandFontPersistenceService');
      const shopifyFontResult = await ingestShopifyThemeFonts(brand);
      applyShopifyFontIngestResult(brand, shopifyFontResult);
      await brand.save();
      console.log(
        `   · shopify theme fonts: via=${shopifyFontResult.via} ${shopifyFontResult.ingested.length} usable, ` +
        `${shopifyFontResult.flagged.length} flagged, heading=${shopifyFontResult.usage?.heading || 'unknown'}, ` +
        `body=${shopifyFontResult.usage?.body || 'unknown'}`
      );
    } catch (err) {
      brand.shopifyFontsIngestError = String(err.message || err).slice(0, 2000);
      await brand.save().catch(() => {});
      console.warn(`   ⚠️  shopify theme font ingest failed for "${brand.name}": ${err.message}`);
    }
  }

  // Fonts identified in the brand's OWN Meta ads. Runs after the website scan on
  // purpose: the website can yield real FILES, and this only yields a NAME, so
  // there is no point paying for the weaker signal first. It still runs even when
  // the website scan succeeded — a site commonly serves only its body face while
  // the ads show the display face.
  // BILLABLE (~$0.02-0.03). Best-effort: never fail the rest of enrichment.
  if (wantMetaFonts) {
    if (run) { await run.checkpoint(); run.stage('meta-ads fonts'); }
    // Hoisted so the catch below can see whether identifyBrandAdFonts
    // actually completed (and if so, whether it spent money) before
    // deciding whether this exception may permanently disable retry.
    let metaResult = null;
    try {
      const { identifyBrandAdFonts } = require('./metaAdsFontService');
      const { applyMetaFontsResult } = require('./brandFontPersistenceService');
      const maxImages = Number(process.env.META_ADS_FONTS_MAX_IMAGES) || 4;
      metaResult = await identifyBrandAdFonts(brand, { maxImages });
      applyMetaFontsResult(brand, metaResult);
      await brand.save();
      console.log(
        `   · meta-ads fonts: via=${metaResult.via} images=${metaResult.imagesUsed} ` +
        `heading=${metaResult.usage.heading?.family || 'none'}` +
        `${metaResult.usage.heading ? `(${metaResult.usage.heading.confidence})` : ''} ` +
        `body=${metaResult.usage.body?.family || 'none'}`
      );
    } catch (err) {
      // CORRECTED 2026-08-31 — this used to stamp unconditionally. The
      // billable-cost reasoning ("a brand whose ads cannot be read must not
      // re-pay the vision call every run") is real but only applies when
      // money was actually put at risk. `identifyBrandAdFonts` itself never
      // throws in normal operation (every step that can fail is caught
      // internally and folded into a normal return with `billableAttempted`
      // set correctly) — so if we get here WITH a metaResult, the exception
      // came from applyMetaFontsResult/brand.save() *after* identification
      // already completed, and metaResult.billableAttempted tells us
      // truthfully whether a billable call happened. Stamping on a bare
      // save() failure for a config-absent (nothing-attempted) result would
      // silently reintroduce the exact bug this fix closes. If metaResult is
      // still null, identifyBrandAdFonts threw before returning at all —
      // an unexpected code fault, not the documented config-absence path —
      // so fall back to the old conservative behaviour and stamp.
      const billableAttempted = !metaResult || metaResult.billableAttempted === true;
      if (billableAttempted) {
        brand.metaFontsIngestedAt = new Date();
      }
      brand.metaFontsIngestError = String(err.message || err).slice(0, 2000);
      await brand.save().catch(() => {});
      console.warn(`   ⚠️  meta-ads font identification failed for "${brand.name}": ${err.message}`);
    }
  }

  // Per-field override log — fire-and-forget calls go to the same
  // server log stream, so this is the only visibility into what the
  // background enrichment actually changed.
  if (overrides.length) {
    for (const o of overrides) {
      const oldStr = o.oldVal == null ? '∅' : (typeof o.oldVal === 'string' && o.oldVal.length > 40 ? o.oldVal.slice(0, 37) + '…' : o.oldVal);
      const newStr = o.newVal == null ? '∅' : (typeof o.newVal === 'string' && o.newVal.length > 40 ? o.newVal.slice(0, 37) + '…' : o.newVal);
      console.log(`   · ${brand.name}.${o.field}: ${JSON.stringify(oldStr)} → ${JSON.stringify(newStr)} [${o.source}]`);
    }
  } else {
    console.log(`   · ${brand.name}: no field changes (all sources returned matching or curated values)`);
  }

  const ranThisTime = [
    wantBrandfetch ? 'brandfetch' : null,
    wantTailwind ? 'tailwind' : null,
    wantScraped    ? 'scraped'    : null,
    (wantGpt && !skipLLM) ? 'gpt'  : null,
    wantBrandReviews ? 'brand-reviews' : null,
    wantFontIngest ? 'website-fonts' : null,
    wantLogoIngest ? 'website-logo' : null,
    wantShopifyFonts ? 'shopify-theme-fonts' : null
  ].filter(Boolean).join('+');
  console.log(`   ✓ brand enrichment done for "${brand.name}" via ${ranThisTime || 'no-op'} — ${overrides.length} field change(s), ${brand.demographics?.length || 0} demographic(s), ${brand.brandReviews?.quotes?.length || 0} brand review(s), all-time sources: [${brand.enrichmentSources.join(', ')}] in ${Date.now() - t0}ms`);
  return { ok: true, brand, overrides };
}

function extractTextFromHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostnameFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

// Find the primary Google Fonts family loaded by the page. Looks for
// <link href="https://fonts.googleapis.com/css2?family=Foo:..."> and
// returns "Foo" (with + → space). Returns null if no Google Fonts link.
function extractGoogleFontsFamily(html) {
  if (!html) return null;
  const re = /<link[^>]+href=["']https:\/\/fonts\.googleapis\.com\/css2?\?[^"']*family=([^&"':]+)/i;
  const m = html.match(re);
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/\+/g, ' ');
}

// Extract a CSS color value from an inline style string (background-color
// preferred, then background if it's a solid color not a url()/gradient).
function extractStyleBackgroundColor(styleStr) {
  if (!styleStr || typeof styleStr !== 'string') return null;
  const bc = styleStr.match(/background-color\s*:\s*([^;]+)/i);
  if (bc) {
    const hex = normalizeWebsiteBackgroundHex(bc[1].trim());
    if (hex) return hex;
  }
  const bg = styleStr.match(/(?:^|;)\s*background\s*:\s*([^;]+)/i);
  if (bg) {
    const val = bg[1].trim();
    // Gradients / images are not solid surfaces.
    if (/url\s*\(|gradient\s*\(/i.test(val)) return null;
    // Take the first token that looks like a color.
    const tokens = val.split(/\s+/);
    for (const tok of tokens) {
      const hex = normalizeWebsiteBackgroundHex(tok);
      if (hex) return hex;
    }
    // rgb(...) may be split across commas — try whole value
    const hexWhole = normalizeWebsiteBackgroundHex(val);
    if (hexWhole) return hexWhole;
  }
  return null;
}

// FLAG: static-HTML heuristic for brand.websiteBackground (page surface).
// Order: <body style> → <html style> → body{...} / html{...} in <style> tags.
// Does NOT use meta theme-color. Does NOT launch headless Chrome.
// Returns normalized '#RRGGBB' or null.
function extractWebsiteBackground(html) {
  if (!html || typeof html !== 'string') return null;

  const openTagStyle = (tagName) => {
    const re = new RegExp(`<${tagName}\\b([^>]*)>`, 'i');
    const m = html.match(re);
    if (!m) return null;
    const styleM = m[1].match(/\bstyle\s*=\s*["']([^"']+)["']/i);
    return styleM ? extractStyleBackgroundColor(styleM[1]) : null;
  };

  const fromBody = openTagStyle('body');
  if (fromBody) return fromBody;
  const fromHtml = openTagStyle('html');
  if (fromHtml) return fromHtml;

  // Inline <style> blocks only (linked CSS not already fetched on this path).
  const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  while ((sm = styleBlockRe.exec(html)) !== null) {
    const css = sm[1]
      // strip CSS comments
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    // Prefer body rules, then html rules. Match simple selectors only.
    const rules = [
      ...css.matchAll(/(?:^|[{},;])\s*body\s*\{([^}]+)\}/gi),
      ...css.matchAll(/(?:^|[{},;])\s*html\s*\{([^}]+)\}/gi)
    ];
    for (const rm of rules) {
      const hex = extractStyleBackgroundColor(rm[1]);
      if (hex) return hex;
    }
  }

  return null;
}

// Last-resort logo fallback: Google's favicon proxy. Returns a 128px PNG
// regardless of whether the site has a real favicon, so it always
// resolves but caps at low resolution.
function googleFaviconFallback(hostname) {
  if (!hostname) return null;
  return `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
}

// Last-resort font picker: maps tone descriptors to a curated set of
// well-known Google Fonts. Used only when Brandfetch + scraping +
// GPT all failed to surface a font. Returns null if nothing matches.
const TONE_FONT_MAP = {
  rugged:    'Bebas Neue',
  bold:      'Bebas Neue',
  loud:      'Anton',
  energetic: 'Oswald',
  outdoors:  'Oswald',
  premium:   'Playfair Display',
  luxury:    'Playfair Display',
  refined:   'Cormorant Garamond',
  elegant:   'Cormorant Garamond',
  editorial: 'Lora',
  technical: 'Inter',
  modern:    'Inter',
  professional: 'Inter',
  practical: 'IBM Plex Sans',
  clean:     'DM Sans',
  minimal:   'DM Sans',
  playful:   'Poppins',
  friendly:  'Poppins',
  warm:      'Nunito',
  casual:    'Nunito',
  fun:       'Quicksand'
};
function toneToDefaultFont(tones) {
  if (!Array.isArray(tones) || tones.length === 0) return null;
  for (const t of tones) {
    const key = String(t).trim().toLowerCase();
    if (TONE_FONT_MAP[key]) return TONE_FONT_MAP[key];
  }
  return null;
}

// Reject font values that aren't real font-family names. Brandfetch
// occasionally returns CSS variable references (e.g. "var(--sl-font-sans)")
// when a site's stylesheet routes its font through a custom property —
// those are useless to us and need to fall through to the next tier.
function isValidFontName(s) {
  if (!s || typeof s !== 'string') return false;
  const v = s.trim();
  if (!v) return false;
  if (v.length > 60) return false;            // real family names are short
  // Google Fonts family names are letters + spaces, optionally with a
  // numeric suffix like "Source Sans 3". Anything else — CSS var()s,
  // page-scrape garbage with newlines, or foundry names with weight
  // suffixes like "NHaasGroteskDSPro-55Rg" (Adobe Typekit) — would
  // never load from fonts.googleapis.com so we reject it and let the
  // chain fall through to GPT-suggested or tone-default.
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(v)) return false;
  return true;
}

// Case-insensitive de-duplication, preserving first occurrence's casing.
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

module.exports = {
  enrichBrandFromUrl,
  preserveBrandReviewNumbers,
  // Exported so scripts/verifyBrandWebsiteBackfill.js exercises the real
  // skip-recording functions rather than a source-text regex.
  markEnrichmentSkipped,
  clearEnrichmentSkipped,
  // Re-exported so callers can `require('./brandEnrichmentService').websiteBackgroundHex`
  // without knowing the util path; transform services import the util directly.
  websiteBackgroundHex,
  normalizeWebsiteBackgroundHex,
  extractWebsiteBackground
};
