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
// Logo URL is set deterministically from Google's favicon service (always
// resolvable, no scraping heuristics).
//
// Fire-and-forget from brandCatalogService — the detect pipeline never
// awaits this. On failure the Brand stays a stub and gets another chance
// next time its website URL shows up on a new media upload.

const axios = require('axios');
const OpenAI = require('openai');

const Brand = require('../models/Brand');
const { lookupBrand: brandfetchLookup } = require('./brandfetchService');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_HTML_CHARS = 25000;

const ENRICHMENT_SCHEMA = {
  type: 'object',
  properties: {
    tagline:        { type: 'string' },
    tone:           { type: 'array', items: { type: 'string' } },
    primaryColor:   { type: 'string' },
    secondaryColor: { type: 'string' },
    accentColor:    { type: 'string' },
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

async function enrichBrandFromUrl(brandId) {
  const brand = await Brand.findById(brandId);
  if (!brand)             return { ok: false, reason: 'brand not found' };
  if (!brand.websiteUrl)  return { ok: false, reason: 'no websiteUrl' };

  // Per-field protection (curatedFields) replaces the old wholesale
  // 'curated' / 'enriched' bail-outs. We re-run enrichment whenever an
  // auto-source is missing from the attempted list — Brandfetch is the
  // most common gap (e.g. older brands enriched before the API key was
  // configured) and it's the highest-quality source so we want to
  // backfill it whenever we can.
  const sourcesAttempted = new Set(brand.enrichmentSources || []);
  const wantBrandfetch   = !!process.env.BRANDFETCH_API_KEY && !sourcesAttempted.has('brandfetch');
  const wantScraped      = !sourcesAttempted.has('scraped');
  const wantGpt          = !!process.env.OPENAI_API_KEY && !sourcesAttempted.has('gpt');

  if (!wantBrandfetch && !wantScraped && !wantGpt) {
    return { ok: false, reason: `nothing to add — sources already attempted: ${[...sourcesAttempted].join(', ') || 'none'}` };
  }

  const t0 = Date.now();
  const planParts = [];
  if (wantBrandfetch) planParts.push('brandfetch');
  if (wantScraped)    planParts.push('scrape');
  if (wantGpt)        planParts.push('gpt');
  console.log(`🌐 brand enrichment: ${brand.websiteUrl} for "${brand.name}" — running ${planParts.join('+')}${sourcesAttempted.size ? ` (already have: ${[...sourcesAttempted].join(', ')})` : ''}`);

  // ── Tier 1: Brandfetch ──
  // Hits the brand kit API for native logo + colors + fonts. Skipped
  // if no API key OR if already attempted on a previous run.
  const hostname = hostnameFromUrl(brand.websiteUrl);
  const bf = (wantBrandfetch && hostname) ? await brandfetchLookup(hostname) : null;
  if (wantBrandfetch && bf) {
    const filled = [];
    for (const k of ['logoUrl', 'primaryColor', 'secondaryColor', 'accentColor', 'fontFamily']) {
      if (bf[k]) filled.push(`${k}=${bf[k].length > 50 ? bf[k].slice(0, 47) + '…' : bf[k]}`);
    }
    console.log(`   · brandfetch returned: ${filled.join(', ') || '(empty)'}`);
  }

  // ── Tier 2: Homepage HTML ──
  let html = '';
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
    const themeMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
    if (themeMatch) metaThemeColor = themeMatch[1];
  } catch (err) {
    console.warn(`   ⚠️  brand enrichment fetch failed for ${brand.websiteUrl}: ${err.message}`);
    // If Brandfetch already gave us the visual identity, the GPT step still
    // adds value (tagline/tone/personas need text). Without HTML we can't
    // do GPT so we have to bail unless Brandfetch gave us enough.
    if (!bf) return { ok: false, reason: `fetch failed: ${err.message}` };
  }

  // Tier 2 helpers — run on whatever HTML we got (may be empty).
  const scrapedLogoUrl     = extractAppleTouchIcon(html, brand.websiteUrl);
  const scrapedFontFamily  = extractGoogleFontsFamily(html);

  const textContent = extractTextFromHtml(html).slice(0, MAX_HTML_CHARS);
  // If HTML was bot-blocked but Brandfetch gave us colors/logo/fonts, we
  // can still write that visual data and skip the GPT-text step gracefully.
  const skipLLM = textContent.length < 200;
  if (skipLLM && !bf) {
    console.warn(`   ⚠️  brand enrichment: ${brand.websiteUrl} returned too little text (${textContent.length} chars) — likely bot-blocked, no Brandfetch fallback`);
    return { ok: false, reason: 'too little text and no Brandfetch data' };
  }

  // ── Tier 3: GPT-4.1 text extraction ──
  // Skipped when we have no usable text (bot-blocked) OR when GPT was
  // already attempted on a previous run. Brandfetch alone can ship
  // partial enrichment without GPT.
  let enrichment = {};
  if (!skipLLM && wantGpt) {
    const prompt =
      `You are analyzing the homepage of "${brand.name}" (${brand.websiteUrl}) to fill a brand catalog entry.\n\n` +
      `Source text from the homepage (HTML stripped):\n"""\n${textContent}\n"""\n\n` +
      `Return JSON matching the schema. Rules:\n` +
      `- "tagline": one line, their own positioning if visible on the page; omit if you can't find it.\n` +
      `- "tone": 2–5 single-word descriptors of the brand's voice (e.g. ["rugged","practical","technical"]).\n` +
      `- "primaryColor" / "secondaryColor" / "accentColor": 6-digit hex strings (e.g. "#0a2540"). Use meta theme-color or visible brand colors when detectable; otherwise best-guess from positioning/category. Omit if truly no signal.\n` +
      `- "demographics": 3–5 key target customer personas this brand clearly serves. Each persona:\n` +
      `    • "name": short, memorable (e.g. "Saltwater Joe", "Weekend Warrior", "Urban Professional")\n` +
      `    • "description": one sentence (≤ 20 words) describing who they are\n` +
      `    • "interests": 3–5 one-word or short-phrase interests\n` +
      `    • "painPoints": 2–4 short phrases describing what they worry about that this brand solves\n` +
      `    • "toneHint": one sentence describing how this persona talks (informs notional quote generation)\n` +
      `Ground personas in the brand's actual positioning; don't invent irrelevant personas. If the brand is niche, 2 personas is fine.`;

    try {
      const response = await openai.chat.completions.create({
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
      if (!bf) return { ok: false, reason: `LLM failed: ${err.message}` };
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
    [bf?.logoUrl, 'brandfetch'],
    [scrapedLogoUrl, 'scraped'],
    [brand.logoUrl, 'existing'],
    [googleFaviconFallback(hostname), 'google-favicon']
  );
  setIf('logoUrl', logoVal, logoSrc);

  let [fontVal, fontSrc] = pick(
    [bf?.fontFamily, 'brandfetch'],
    [scrapedFontFamily, 'scraped'],
    [brand.fontFamily, 'existing']
  );
  setIf('fontFamily', fontVal, fontSrc);

  let [primaryVal, primarySrc] = pick(
    [bf?.primaryColor, 'brandfetch'],
    [metaThemeColor, 'meta-theme-color'],
    [enrichment.primaryColor, 'gpt'],
    [brand.primaryColor, 'existing']
  );
  setIf('primaryColor', primaryVal, primarySrc);

  let [secondaryVal, secondarySrc] = pick(
    [bf?.secondaryColor, 'brandfetch'],
    [enrichment.secondaryColor, 'gpt'],
    [brand.secondaryColor, 'existing']
  );
  setIf('secondaryColor', secondaryVal, secondarySrc);

  let [accentVal, accentSrc] = pick(
    [bf?.accentColor, 'brandfetch'],
    [enrichment.accentColor, 'gpt'],
    [brand.accentColor, 'existing']
  );
  setIf('accentColor', accentVal, accentSrc);

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
  if (!isCurated('demographics') && Array.isArray(enrichment.demographics) && enrichment.demographics.length) {
    brand.demographics = enrichment.demographics.slice(0, 6).map(d => ({
      name:        d.name,
      description: d.description || '',
      interests:   Array.isArray(d.interests)  ? d.interests.slice(0, 6)  : [],
      painPoints:  Array.isArray(d.painPoints) ? d.painPoints.slice(0, 4) : [],
      toneHint:    d.toneHint || ''
    }));
  }
  // Track which sources we ATTEMPTED on this run so subsequent runs
  // know whether to backfill (e.g. Brandfetch came online later).
  const newSourcesAttempted = new Set(brand.enrichmentSources || []);
  if (wantBrandfetch) newSourcesAttempted.add('brandfetch');
  if (wantScraped)    newSourcesAttempted.add('scraped');
  if (wantGpt && !skipLLM) newSourcesAttempted.add('gpt');
  brand.enrichmentSources = [...newSourcesAttempted];

  brand.source = 'enriched';
  brand.enrichedAt = new Date();
  await brand.save();

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
    wantScraped    ? 'scraped'    : null,
    (wantGpt && !skipLLM) ? 'gpt'  : null
  ].filter(Boolean).join('+');
  console.log(`   ✓ brand enrichment done for "${brand.name}" via ${ranThisTime || 'no-op'} — ${overrides.length} field change(s), ${brand.demographics?.length || 0} demographic(s), all-time sources: [${brand.enrichmentSources.join(', ')}] in ${Date.now() - t0}ms`);
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

// Find the largest apple-touch-icon link in the HTML and resolve it to
// an absolute URL. Apple-touch-icons are typically 180-512px PNGs of the
// brand mark — much higher quality than the 128px Google favicon and
// usually clean (sites care about how their iOS bookmark looks).
// Returns null if no link found.
function extractAppleTouchIcon(html, baseUrl) {
  if (!html) return null;
  const linkRegex = /<link\b[^>]*rel=["']apple-touch-icon(?:-precomposed)?["'][^>]*>/gi;
  const candidates = [];
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const tag = m[0];
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const sizesMatch = tag.match(/sizes=["']([^"']+)["']/i);
    let size = 0;
    if (sizesMatch) {
      const dim = sizesMatch[1].match(/(\d+)x(\d+)/i);
      if (dim) size = Math.max(parseInt(dim[1], 10), parseInt(dim[2], 10));
    }
    candidates.push({ href: hrefMatch[1], size });
  }
  if (!candidates.length) return null;
  // Largest icon wins (sites with sizes="180x180" beat sizes="").
  candidates.sort((a, b) => b.size - a.size);
  try {
    return new URL(candidates[0].href, baseUrl).toString();
  } catch {
    return null;
  }
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

// Last-resort logo fallback: Google's favicon proxy. Returns a 128px PNG
// regardless of whether the site has a real favicon, so it always
// resolves but caps at low resolution.
function googleFaviconFallback(hostname) {
  if (!hostname) return null;
  return `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
}

module.exports = { enrichBrandFromUrl };
